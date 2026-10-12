/** Google Calendar: events that took place in the window (past events = 実績), across the calendars shown in the UI. */
import { googleJson } from "../google";
import type { Collector } from "../types";

const API = "https://www.googleapis.com/calendar/v3";

interface CalendarListEntry { id: string; summary: string; selected?: boolean; primary?: boolean; accessRole: string }
interface EventItem {
  id: string; status: string; summary?: string; location?: string; description?: string;
  start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string };
  attendees?: { email?: string; responseStatus?: string; self?: boolean }[]; eventType?: string; htmlLink?: string;
}
type Item = { calendar: string; calendarId: string; event: EventItem };

export const calendar: Collector = {
  id: "calendar",
  label: "Google Calendar",
  lookbackDays: 7,
  configured: (env) => (env.GOOGLE_REFRESH_TOKEN ? true : "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"),
  async collect({ env, http, google, from, to }) {
    const list = await googleJson<{ items: CalendarListEntry[] }>(http, google, `${API}/users/me/calendarList?minAccessRole=reader`);
    const wanted = env.GOOGLE_CALENDAR_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
    const cals = list.items.filter((c) => (wanted?.length ? wanted.includes(c.id) || (c.primary && wanted.includes("primary")) : c.selected || c.primary));
    const items: Item[] = [];
    for (const cal of cals) {
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(pageToken ? { pageToken } : {}) });
        const r = await googleJson<{ items: EventItem[]; nextPageToken?: string }>(http, google, `${API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
        for (const ev of r.items) {
          if (ev.status === "cancelled") continue;
          if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue; // declined: did not happen for me
          items.push({ calendar: cal.summary, calendarId: cal.id, event: ev });
        }
        pageToken = r.nextPageToken;
      } while (pageToken);
    }
    return { items, meta: { calendars: cals.map((c) => c.summary) } };
  },
  digest(item) {
    const { calendar: cal, event: e } = item as Item;
    const start = e.start.dateTime ? e.start.dateTime.slice(0, 16).replace("T", " ") : `${e.start.date} (終日)`;
    const end = e.end.dateTime ? e.end.dateTime.slice(11, 16) : "";
    return `${start}${end ? `–${end}` : ""} [${cal}] ${e.summary ?? "(無題)"}${e.location ? ` @${e.location}` : ""}`;
  },
};
