/**
 * Google Calendar, two parts per run:
 *   past     — events that took place since the previous run (実績), as before.
 *   upcoming — events from now up to 2 years ahead (or GOOGLE_CALENDAR_HORIZON_DAYS days). Fetched in full every run but
 *              only what is new / changed / removed since the previous run goes into the feed (the cursor keeps a
 *              signature per event). Recurring events collapse to one item per series.
 * Calendars: the ones shown in Google Calendar (or GOOGLE_CALENDAR_IDS). Cancelled and declined events are skipped.
 */
import { googleJson, type GoogleAuth } from "../google";
import type { HttpClient } from "../http";
import type { Collector } from "../types";

const API = "https://www.googleapis.com/calendar/v3";
const DAY = 86_400_000;
export const DEFAULT_HORIZON_YEARS = 2;

interface CalendarListEntry { id: string; summary: string; selected?: boolean; primary?: boolean; accessRole: string }
export interface EventItem {
  id: string; status: string; summary?: string; location?: string; description?: string; updated?: string; recurringEventId?: string;
  start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string };
  attendees?: { email?: string; responseStatus?: string; self?: boolean }[]; eventType?: string; htmlLink?: string;
}
type Cal = { id: string; summary: string };

/** `key` (calendarId|recurringEventId-or-id) identifies an upcoming event / series across runs: `kb calendar import` applies the diffs by it. */
export type CalendarItem =
  | { when: "past"; calendar: string; calendarId: string; event: EventItem }
  | { when: "upcoming"; change: "new" | "updated"; key: string; calendar: string; calendarId: string; event: EventItem; recurring?: { count: number; first: string; last: string } }
  | { when: "upcoming"; change: "removed"; key: string; calendar: string; calendarId: string; summary: string; start: string };

/** Per upcoming event / series: enough to detect a change and to describe it once it disappears. */
interface Seen { sig: string; end: string; summary: string; start: string; calendar: string; calendarId: string }
interface Cursor { v: 1; upcoming: Record<string, Seen> }

const startOf = (e: EventItem) => e.start.dateTime ?? e.start.date ?? "";
const endOf = (e: EventItem) => e.end.dateTime ?? e.end.date ?? "";
/** All-day dates are local calendar dates: compare them as local midnight. */
const timeOf = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`).getTime() : Date.parse(s));

async function listEvents(http: HttpClient, google: GoogleAuth, cal: Cal, from: Date, to: Date): Promise<EventItem[]> {
  const out: EventItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500", ...(pageToken ? { pageToken } : {}) });
    const r = await googleJson<{ items: EventItem[]; nextPageToken?: string }>(http, google, `${API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
    for (const ev of r.items) {
      if (ev.status === "cancelled") continue;
      if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue; // declined: not happening for me
      out.push(ev);
    }
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/** Diff the upcoming window against what the previous run saw. Exported for tests. */
export function diffUpcoming(prev: Record<string, Seen>, events: { cal: Cal; event: EventItem }[], now: Date): { items: CalendarItem[]; next: Record<string, Seen> } {
  // group instances of a recurring event into one series
  const groups = new Map<string, { cal: Cal; events: EventItem[] }>();
  for (const { cal, event } of events) {
    const key = `${cal.id}|${event.recurringEventId ?? event.id}`;
    const g = groups.get(key) ?? { cal, events: [] };
    g.events.push(event);
    groups.set(key, g);
  }
  const items: CalendarItem[] = [];
  const next: Record<string, Seen> = {};
  for (const [key, { cal, events: evs }] of groups) {
    evs.sort((a, b) => timeOf(startOf(a)) - timeOf(startOf(b)));
    const first = evs[0]!, last = evs[evs.length - 1]!;
    const series = !!first.recurringEventId;
    // the sliding window adds/drops instances every day, so a series' signature ignores the count and dates:
    // only edits (updated) or a rename count as a change
    const maxUpdated = evs.reduce((a, e) => (e.updated && e.updated > a ? e.updated : a), "");
    const sig = series ? `${maxUpdated}|${first.summary ?? ""}` : `${first.updated ?? ""}|${startOf(first)}|${endOf(first)}|${first.summary ?? ""}`;
    next[key] = { sig, end: endOf(last), summary: first.summary ?? "", start: startOf(first), calendar: cal.summary, calendarId: cal.id };
    const before = prev[key];
    if (before && before.sig === sig) continue;
    items.push({
      when: "upcoming", change: before ? "updated" : "new", key, calendar: cal.summary, calendarId: cal.id, event: first,
      ...(series ? { recurring: { count: evs.length, first: startOf(first), last: startOf(last) } } : {}),
    });
  }
  for (const [key, s] of Object.entries(prev)) {
    if (next[key]) continue;
    if (timeOf(s.end) <= now.getTime()) continue; // it simply happened: the past part reports it
    items.push({ when: "upcoming", change: "removed", key, calendar: s.calendar, calendarId: s.calendarId, summary: s.summary, start: s.start });
  }
  return { items, next };
}

export const calendar: Collector = {
  id: "calendar",
  label: "Google Calendar",
  lookbackDays: 7,
  configured: (env) => (env.GOOGLE_REFRESH_TOKEN ? true : "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"),
  async collect({ env, http, google, from, to, cursor }) {
    const list = await googleJson<{ items: CalendarListEntry[] }>(http, google, `${API}/users/me/calendarList?minAccessRole=reader`);
    const wanted = env.GOOGLE_CALENDAR_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
    const cals = list.items.filter((c) => (wanted?.length ? wanted.includes(c.id) || (c.primary && wanted.includes("primary")) : c.selected || c.primary));
    const days = Number(env.GOOGLE_CALENDAR_HORIZON_DAYS);
    const horizon = days > 0 ? new Date(to.getTime() + days * DAY) : new Date(new Date(to).setFullYear(to.getFullYear() + DEFAULT_HORIZON_YEARS));

    const past: CalendarItem[] = [];
    const ahead: { cal: Cal; event: EventItem }[] = [];
    for (const cal of cals) {
      for (const event of await listEvents(http, google, cal, from, to)) past.push({ when: "past", calendar: cal.summary, calendarId: cal.id, event });
      for (const event of await listEvents(http, google, cal, to, horizon)) ahead.push({ cal, event });
    }
    const prev: Cursor = cursor ? JSON.parse(cursor) : { v: 1, upcoming: {} };
    const { items: upcoming, next } = diffUpcoming(prev.upcoming ?? {}, ahead, to);
    return {
      items: [...past, ...upcoming],
      meta: { calendars: cals.map((c) => c.summary), horizon: horizon.toISOString(), past: past.length, upcoming_changes: upcoming.length, upcoming_total: Object.keys(next).length },
      cursor: JSON.stringify({ v: 1, upcoming: next } satisfies Cursor),
    };
  },
  digest(item) {
    const it = item as CalendarItem | { calendar: string; event: EventItem }; // feeds before 2026-10-12 had no `when`
    const when = (e: EventItem) => {
      const start = e.start.dateTime ? e.start.dateTime.slice(0, 16).replace("T", " ") : `${e.start.date} (終日)`;
      const end = e.end.dateTime ? e.end.dateTime.slice(11, 16) : "";
      return `${start}${end ? `–${end}` : ""}`;
    };
    const what = (e: EventItem) => `${e.summary ?? "(無題)"}${e.location ? ` @${e.location}` : ""}`;
    if (!("when" in it) || it.when === "past") return `実績 ${when(it.event)} [${it.calendar}] ${what(it.event)}`;
    if (it.change === "removed") return `予定・削除 ${it.start.slice(0, 16).replace("T", " ")} [${it.calendar}] ${it.summary}`;
    const label = it.change === "new" ? "予定・新規" : "予定・変更";
    if (it.recurring) return `${label} 繰り返し ${it.recurring.count} 回（${it.recurring.first.slice(0, 10)}〜${it.recurring.last.slice(0, 10)}）${when(it.event).slice(10)} [${it.calendar}] ${what(it.event)}`;
    return `${label} ${when(it.event)} [${it.calendar}] ${what(it.event)}`;
  },
};
