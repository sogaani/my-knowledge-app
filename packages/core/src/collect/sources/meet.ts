/**
 * Google Meet: the conferences that ended in the window, with who took part and the transcript (speaker-attributed
 * entries from the Meet REST API). Opt-in: the source runs only when `meet` is listed in GOOGLE_SOURCES (default
 * account) / GOOGLE_SOURCES__<account>, because it needs one more consent scope (meetings.space.readonly) and the
 * transcript is company material that normally belongs to a work account.
 *
 * What the API gives: conferenceRecords (start / end / space), the space's meeting code, participants' display names,
 * transcripts (entries with participant + text; also a Google Doc in Drive, linked but not downloaded: that would
 * need the restricted Drive scope) and recordings (Drive export links only). Transcript entries are kept by Google for
 * 30 days after the conference, so the daily run is what makes this reliable. Meetings with no transcript still appear
 * (time, title, participants) so the record of the meeting is kept. The meeting title is not in the Meet API: it is
 * looked up (best effort) in the primary calendar by meeting code, which the calendar scope the account already has
 * allows; without it the item just has no title.
 */
import { parseGoogleSources } from "../accounts";
import { googleJson, type GoogleAuth } from "../google";
import type { HttpClient } from "../http";
import type { Collector, Logger } from "../types";

const API = "https://meet.googleapis.com/v2";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const DAY = 86_400_000;

interface ConferenceRecord { name: string; startTime: string; endTime?: string; expireTime?: string; space?: string }
interface Space { name: string; meetingUri?: string; meetingCode?: string }
interface Participant { name: string; signedinUser?: { user?: string; displayName?: string }; anonymousUser?: { displayName?: string }; phoneUser?: { displayName?: string } }
interface Transcript { name: string; state: string; startTime?: string; endTime?: string; docsDestination?: { document?: string; exportUri?: string } }
interface TranscriptEntry { name: string; participant: string; text: string; languageCode?: string; startTime: string; endTime?: string }
interface Recording { name: string; state: string; driveDestination?: { file?: string; exportUri?: string } }
interface CalEvent { summary?: string; conferenceData?: { conferenceId?: string }; hangoutLink?: string }

export interface MeetEntry { at: string; who: string; text: string }
export interface MeetItem {
  /** conferenceRecords/<id> */
  record: string;
  meeting_code?: string;
  meeting_uri?: string;
  /** From the primary calendar's event with the same meeting code; absent when no event matched. */
  title?: string;
  start: string;
  end: string;
  minutes: number;
  participants: string[];
  transcript?: { document?: string; export_uri?: string; language?: string; entries: MeetEntry[] };
  /** Drive export links of recordings (not downloaded). */
  recordings: string[];
}

async function paged<T>(http: HttpClient, google: GoogleAuth, url: string, key: string, params: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
    const r = await googleJson<Record<string, unknown> & { nextPageToken?: string }>(http, google, `${url}?${q}`);
    out.push(...((r[key] as T[] | undefined) ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

const nameOf = (p: Participant) => p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || "(不明)";

/** Entries in time order, consecutive entries of the same speaker joined into one. Exported for tests. */
export function mergeEntries(entries: TranscriptEntry[], names: Map<string, string>): MeetEntry[] {
  const out: MeetEntry[] = [];
  for (const e of [...entries].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const who = names.get(e.participant) ?? "(不明)";
    const text = e.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.who === who) last.text += ` ${text}`;
    else out.push({ at: e.startTime, who, text });
  }
  return out;
}

/** meeting code → event title, from the primary calendar around the window. Any failure (no calendar scope, …) → empty. */
async function calendarTitles(http: HttpClient, google: GoogleAuth, from: Date, to: Date, log: Logger): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const events = await paged<CalEvent>(http, google, `${CAL_API}/calendars/primary/events`, "items", {
      timeMin: new Date(from.getTime() - DAY).toISOString(), timeMax: new Date(to.getTime() + DAY).toISOString(), singleEvents: "true", maxResults: "2500",
      fields: "items(summary,conferenceData/conferenceId,hangoutLink),nextPageToken",
    });
    for (const ev of events) {
      if (!ev.summary) continue;
      const code = ev.conferenceData?.conferenceId ?? ev.hangoutLink?.split("/").pop()?.split("?")[0];
      if (code && !titles.has(code)) titles.set(code, ev.summary);
    }
  } catch (e) {
    log.warn(`  meet: calendar titles unavailable (${String((e as Error).message ?? e).slice(0, 120)})`);
  }
  return titles;
}

export const meet: Collector = {
  id: "meet",
  label: "Google Meet",
  lookbackDays: 7,
  configured: (env) =>
    !env.GOOGLE_REFRESH_TOKEN ? "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"
    : parseGoogleSources(env.GOOGLE_SOURCES).includes("meet") ? true
    : "meet not in GOOGLE_SOURCES (opt in with bun run collect auth google [--account <name>] --sources …,meet)",
  async collect({ http, google, from, to, log }) {
    // conferences that ended in the window; ones still running (no end_time) are picked up next time
    const filter = `end_time>="${from.toISOString()}" AND end_time<"${to.toISOString()}"`;
    const records = (await paged<ConferenceRecord>(http, google, `${API}/conferenceRecords`, "conferenceRecords", { filter, pageSize: "100" })).filter((r) => r.endTime);
    const titles = records.length ? await calendarTitles(http, google, from, to, log) : new Map<string, string>();
    const items: MeetItem[] = [];
    for (const rec of records) {
      const [space, participants, transcripts, recordings] = await Promise.all([
        rec.space ? googleJson<Space>(http, google, `${API}/${rec.space}`).catch(() => undefined) : undefined,
        paged<Participant>(http, google, `${API}/${rec.name}/participants`, "participants", { pageSize: "250" }),
        paged<Transcript>(http, google, `${API}/${rec.name}/transcripts`, "transcripts"),
        paged<Recording>(http, google, `${API}/${rec.name}/recordings`, "recordings"),
      ]);
      const names = new Map(participants.map((p) => [p.name, nameOf(p)]));
      const code = space?.meetingCode;
      const item: MeetItem = {
        record: rec.name, ...(code ? { meeting_code: code } : {}), ...(space?.meetingUri ? { meeting_uri: space.meetingUri } : {}),
        ...(code && titles.get(code) ? { title: titles.get(code) } : {}),
        start: rec.startTime, end: rec.endTime!, minutes: Math.max(1, Math.round((Date.parse(rec.endTime!) - Date.parse(rec.startTime)) / 60_000)),
        participants: [...new Set(names.values())],
        recordings: recordings.map((r) => r.driveDestination?.exportUri).filter((u): u is string => !!u),
      };
      const ended = transcripts.filter((t) => t.state !== "STARTED");
      if (ended.length) {
        const entries: TranscriptEntry[] = [];
        for (const t of ended) entries.push(...(await paged<TranscriptEntry>(http, google, `${API}/${t.name}/entries`, "transcriptEntries", { pageSize: "1000" })));
        const doc = ended.find((t) => t.docsDestination?.document)?.docsDestination;
        item.transcript = { ...(doc?.document ? { document: doc.document } : {}), ...(doc?.exportUri ? { export_uri: doc.exportUri } : {}), ...(entries[0]?.languageCode ? { language: entries[0].languageCode } : {}), entries: mergeEntries(entries, names) };
      }
      items.push(item);
    }
    items.sort((a, b) => a.start.localeCompare(b.start));
    return { items, meta: { conferences: items.length, with_transcript: items.filter((i) => i.transcript).length } };
  },
  digest(item) {
    const it = item as MeetItem;
    const local = (iso: string) => new Date(iso).toLocaleString("sv-SE").slice(0, 16); // YYYY-MM-DD HH:MM, Mac local time
    const hhmm = (iso: string) => local(iso).slice(11);
    const n = it.transcript?.entries.length ?? 0;
    const head = `${local(it.start)}–${hhmm(it.end)} ${it.title ?? "（予定名不明）"}（${it.minutes} 分・${it.participants.length} 人・${n ? `発言 ${n} 件` : "文字起こしなし"}）${it.meeting_code ? ` ${it.meeting_code}` : ""}${it.recordings.length ? " 録画あり" : ""}`;
    if (!n) return head;
    return [head, ...it.transcript!.entries.map((e) => `    ${hhmm(e.at)} ${e.who}: ${e.text}`)].join("\n");
  },
};
