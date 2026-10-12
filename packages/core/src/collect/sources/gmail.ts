/**
 * Gmail: messages the Apps Script classifier labelled KB/* and that are not yet KB/取込済. One mail-*.json per message
 * (same naming as the old Apps Script push, so ingest's mail-*-<category>-* rules keep working), then label them
 * KB/取込済 once the files are in the inbox.
 */
import { googleJson } from "../google";
import { mapLimit } from "../http";
import type { Collector, InboxFile } from "../types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const FETCHED_LABEL = "KB/取込済";
/** Gmail label → ASCII slug in file names (NFC/NFD-safe). Keep in sync with the Apps Script CATEGORY_LABEL. */
export const GMAIL_LABELS: Record<string, string> = {
  "KB/購入": "purchase", "KB/サブスク": "subscription", "KB/金融": "finance", "KB/本": "book", "KB/視聴": "media", "KB/作業": "work",
};
const MAX_PER_RUN = 200;
const BODY_CHARS = 20_000;

interface Header { name: string; value: string }
interface Part { mimeType: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] }
interface Message { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate: string; payload: Part }

export interface MailItem {
  source: "gmail";
  gmail_id: string;
  gmail_thread: string;
  gmail_label: string;
  category: string;
  date: string; // ISO
  from: string;
  to: string;
  subject: string;
  attachments: string[];
  body: string;
  body_truncated: boolean;
  snippet: string;
  label_ids: string[];
  headers: Header[];
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function walk(p: Part, f: (p: Part) => void) {
  f(p);
  for (const c of p.parts ?? []) walk(c, f);
}

/** Plain-text body: the text/plain part, else the HTML part with tags stripped. */
export function bodyText(payload: Part): string {
  let plain = "", html = "";
  walk(payload, (p) => {
    if (!p.body?.data || p.filename) return;
    if (p.mimeType === "text/plain" && !plain) plain = b64(p.body.data);
    else if (p.mimeType === "text/html" && !html) html = b64(p.body.data);
  });
  const text = plain || html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function toMailItem(m: Message, label: string): MailItem {
  const h = (n: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  const attachments: string[] = [];
  walk(m.payload, (p) => { if (p.filename) attachments.push(p.filename); });
  const body = bodyText(m.payload);
  return {
    source: "gmail", gmail_id: m.id, gmail_thread: m.threadId, gmail_label: label, category: GMAIL_LABELS[label] ?? "other",
    date: new Date(Number(m.internalDate)).toISOString(), from: h("from"), to: h("to"), subject: h("subject"),
    attachments, body: body.slice(0, BODY_CHARS), body_truncated: body.length > BODY_CHARS, snippet: m.snippet ?? "",
    label_ids: m.labelIds ?? [], headers: (m.payload.headers ?? []).filter((x) => /^(from|to|cc|date|subject|reply-to|list-id|message-id)$/i.test(x.name)),
  };
}

export const mailFileName = (it: MailItem) => `mail-${new Date(it.date).toLocaleDateString("sv-SE").replace(/-/g, "")}-${it.category}-${it.gmail_id}.json`;

export const gmail: Collector = {
  id: "gmail",
  label: "Gmail",
  lookbackDays: 0, // label-driven, not time-driven
  configured: (env) => (env.GOOGLE_REFRESH_TOKEN ? (env.GMAIL === "off" ? "GMAIL=off" : true) : "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"),
  async collect({ http, google, log }) {
    const { labels } = await googleJson<{ labels: { id: string; name: string }[] }>(http, google, `${API}/labels`);
    const idOf = new Map(labels.map((l) => [l.name, l.id]));
    const fetchedId = idOf.get(FETCHED_LABEL);
    if (!fetchedId) throw new Error(`Gmail label ${FETCHED_LABEL} not found (run setupLabels in the Apps Script)`);

    const todo: { id: string; label: string }[] = [];
    for (const label of Object.keys(GMAIL_LABELS)) {
      const labelId = idOf.get(label);
      if (!labelId) { log.warn(`  gmail: label ${label} not found, skipped`); continue; }
      let pageToken: string | undefined;
      do {
        // nested label names are matched as "kb-取込済" by some clients: exclude both spellings (a form that matches nothing is harmless)
        const q = new URLSearchParams({ labelIds: labelId, q: `-label:"${FETCHED_LABEL}" -label:${FETCHED_LABEL.toLowerCase().replace(/\//g, "-")}`, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
        const r = await googleJson<{ messages?: { id: string }[]; nextPageToken?: string }>(http, google, `${API}/messages?${q}`);
        for (const m of r.messages ?? []) todo.push({ id: m.id, label });
        pageToken = r.nextPageToken;
      } while (pageToken && todo.length < MAX_PER_RUN);
    }
    const seen = new Set<string>();
    const unique = todo.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))).slice(0, MAX_PER_RUN);

    // the search may still let fetched mail through: check labels cheaply (format=minimal) before pulling bodies
    const minimal = await mapLimit(unique, 10, (t) => googleJson<{ labelIds?: string[] }>(http, google, `${API}/messages/${t.id}?format=minimal`));
    const pending = unique.filter((_, i) => !(minimal[i]!.labelIds ?? []).includes(fetchedId));
    const msgs = await mapLimit(pending, 5, (t) => googleJson<Message>(http, google, `${API}/messages/${t.id}?format=full`).then((m) => ({ m, label: t.label })));
    const items = msgs.map(({ m, label }) => toMailItem(m, label));
    const files: InboxFile[] = items.map((it) => ({ name: mailFileName(it), json: it }));
    return {
      files,
      commit: async () => {
        for (let i = 0; i < items.length; i += 1000) {
          await googleJson(http, google, `${API}/messages/batchModify`, { method: "POST", body: JSON.stringify({ ids: items.slice(i, i + 1000).map((x) => x.gmail_id), addLabelIds: [fetchedId] }) });
        }
      },
    };
  },
  digest(item) {
    const it = item as MailItem;
    return `${it.date.slice(0, 10)} [${it.category}] ${it.subject} — ${it.from}`;
  },
};
