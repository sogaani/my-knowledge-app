/**
 * Readable rendering of collector JSON for `kb source`: the ingest agent reads this, not the raw API objects.
 * Feeds (collect-*.json) → header + one line per item via the collector's digest(); mail-*.json → header block + body.
 */
import { COLLECTORS } from "./registry";
import type { Feed } from "./types";
import type { MailItem } from "./sources/gmail";

export function digestJson(text: string): string | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<Feed> & Partial<MailItem>;
  if (o.source === "gmail" && typeof o.gmail_id === "string") {
    const m = o as MailItem;
    return [
      `from: ${m.from}`, `to: ${m.to}`, `date: ${m.date}`, `subject: ${m.subject}`, `gmail_id: ${m.gmail_id}`, `gmail_thread: ${m.gmail_thread}`,
      `gmail_label: ${m.gmail_label}`, `category: ${m.category}`, `attachments: ${m.attachments.join(", ") || "(none)"}`,
      "---", m.body + (m.body_truncated ? "\n…(truncated)" : ""),
    ].join("\n");
  }
  if (typeof o.source === "string" && Array.isArray(o.items)) {
    const c = COLLECTORS.find((x) => x.id === o.source);
    const line = (it: unknown) => { try { return c ? c.digest(it) : JSON.stringify(it).slice(0, 200); } catch { return JSON.stringify(it).slice(0, 200); } };
    return [
      `# ${c?.label ?? o.source} ${o.from} 〜 ${o.to}（${o.count ?? o.items.length} 件）`,
      ...(o.meta ? [`meta: ${JSON.stringify(o.meta)}`] : []),
      "",
      ...o.items.map((it) => `- ${line(it)}`),
    ].join("\n");
  }
  return null;
}
