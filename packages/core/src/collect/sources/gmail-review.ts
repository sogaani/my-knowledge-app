/**
 * Gmail `システム/要確認`: the mails the Apps Script classifier could not place (P(kb) between the thresholds). They are
 * not collected as mail; once a week this writes a digest feed (collect-gmail-review-<from>_<to>.json) with the
 * date / sender / subject of the mails that arrived in the window, so the ingest skill can report them and the owner
 * labels the ones that belong in the KB (`KB/*` by hand → the next gmail run fetches them). No bodies, no labels
 * changed. On the other days the window is left open (lastTo stays) and nothing is written.
 */
import { googleJson } from "../google";
import { mapLimit } from "../http";
import { DAY_MS, startOfDay } from "../dates";
import type { Collector } from "../types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const REVIEW_LABEL = "システム/要確認";
export const REVIEW_PERIOD_DAYS = 7;
const MAX_PER_RUN = 500;

interface Header { name: string; value: string }
interface MetaMessage { id: string; threadId: string; internalDate: string; payload?: { headers?: Header[] } }

export interface ReviewItem { gmail_id: string; gmail_thread: string; date: string; from: string; subject: string }

/** The weekly window is due when at least REVIEW_PERIOD_DAYS calendar days separate `from` and `to`. */
export const reviewDue = (from: Date, to: Date) => startOfDay(to).getTime() - startOfDay(from).getTime() >= REVIEW_PERIOD_DAYS * DAY_MS;

export function toReviewItem(m: MetaMessage): ReviewItem {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  return { gmail_id: m.id, gmail_thread: m.threadId, date: new Date(Number(m.internalDate)).toISOString(), from: h("from"), subject: h("subject") };
}

export const gmailReview: Collector = {
  id: "gmail-review",
  label: `Gmail ${REVIEW_LABEL}（週次ダイジェスト）`,
  lookbackDays: REVIEW_PERIOD_DAYS,
  configured: (env) => (env.GOOGLE_REFRESH_TOKEN ? (env.GMAIL_REVIEW === "off" || env.GMAIL === "off" ? "GMAIL_REVIEW=off" : true) : "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"),
  async collect({ http, google, from, to }) {
    // not due yet: keep the window open (to = from leaves lastTo where it was) and write nothing
    if (!reviewDue(from, to)) return { from, to: from };
    const { labels } = await googleJson<{ labels: { id: string; name: string }[] }>(http, google, `${API}/labels`);
    const labelId = labels.find((l) => l.name === REVIEW_LABEL)?.id;
    if (!labelId) throw new Error(`Gmail label ${REVIEW_LABEL} not found (run setupLabels in the Apps Script)`);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        labelIds: labelId, maxResults: "100",
        q: `after:${Math.floor(from.getTime() / 1000)} before:${Math.floor(to.getTime() / 1000)}`,
        ...(pageToken ? { pageToken } : {}),
      });
      const r = await googleJson<{ messages?: { id: string }[]; nextPageToken?: string }>(http, google, `${API}/messages?${q}`);
      for (const m of r.messages ?? []) ids.push(m.id);
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < MAX_PER_RUN);
    // headers only: the digest never carries a body
    const msgs = await mapLimit(ids.slice(0, MAX_PER_RUN), 10, (id) => googleJson<MetaMessage>(http, google, `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`));
    const items = msgs.map(toReviewItem).sort((a, b) => a.date.localeCompare(b.date));
    return { items, meta: { label: REVIEW_LABEL, hint: "KB に入れるものは Gmail で KB/* ラベルを手で付ける（次回の gmail 収集で取得される）" } };
  },
  digest(item) {
    const it = item as ReviewItem;
    return `${it.date.slice(0, 10)} ${it.subject || "(no subject)"} — ${it.from}`;
  },
};
