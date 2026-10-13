/**
 * `kb calendar import <bronze-id>`: Google Calendar feeds (collect-calendar-*.json) → monthly `calendar_log` notes
 * (200_silver/212_calendar, git-crypt). The feeds hold past events (実績) and diffs of upcoming events (new / changed /
 * removed), so the notes are rebuilt by replaying every calendar feed in Bronze in capture order: the same Bronze always
 * gives the same notes. Events also go to frontmatter `events` for the cross-domain Gold views (390 / 391 / 392).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { bronzeDir, markProcessed, readMeta, walkBronze } from "./bronze";
import { createNote, monthlyTitle } from "./create";
import { parseNote, stringifyNote } from "./frontmatter";
import { runQuery } from "./query";
import type { SchemaRegistry } from "./schema";
import type { Feed } from "./collect/types";
import type { CalendarItem, EventItem } from "./collect/sources/calendar";
import { localDate, localTime } from "./wallclock";

const BEGIN = "<!-- kb:calendar:start -->";
const END = "<!-- kb:calendar:end -->";
const isCalendarFeed = (f: string) => /^collect-calendar-.*\.json$/.test(f);

/** One event as kept in the notes (no descriptions or attendees: titles, times and places only). */
export interface CalEvent {
  key: string;
  date: string; // YYYY-MM-DD, wall clock where it happens
  start: string; // HH:MM, "" for all-day
  end: string;
  title: string;
  calendar: string;
  location?: string;
  status: "done" | "planned";
  /** upcoming recurring series: one entry dated at its first upcoming instance */
  recurring?: { count: number; first: string; last: string };
}

function toEvent(key: string, calendar: string, e: EventItem, status: CalEvent["status"], recurring?: CalEvent["recurring"]): CalEvent {
  const s = e.start.dateTime ?? e.start.date ?? "", en = e.end.dateTime ?? e.end.date ?? "";
  return {
    key, date: localDate(s), start: localTime(s), end: localTime(en), title: e.summary ?? "(無題)", calendar, status,
    ...(e.location ? { location: e.location } : {}),
    ...(recurring ? { recurring: { count: recurring.count, first: localDate(recurring.first), last: localDate(recurring.last) } } : {}),
  };
}

/** Replay feeds (oldest capture first). Items of feeds written before 2026-10-12 have no `when`: they are past events. */
export function replayCalendar(feeds: Feed<CalendarItem | { calendar: string; calendarId: string; event: EventItem }>[]): Map<string, CalEvent> {
  const state = new Map<string, CalEvent>();
  for (const feed of feeds) {
    for (const it of feed.items) {
      if (!("when" in it) || it.when === "past") {
        const key = `${it.calendarId}|${it.event.id}`;
        state.set(key, toEvent(key, it.calendar, it.event, "done"));
      } else if (it.change === "removed") {
        // feeds before keys were added: match the removed event by calendar, title and start
        const key = it.key ?? [...state.values()].find((e) => e.status === "planned" && e.key.startsWith(`${it.calendarId}|`) && e.title === it.summary && e.date === localDate(it.start))?.key;
        if (key && state.get(key)?.status === "planned") state.delete(key);
      } else {
        const key = it.key ?? `${it.calendarId}|${it.event.recurringEventId ?? it.event.id}`;
        if (state.get(key)?.status === "done") continue; // already happened: keep the 実績
        state.set(key, toEvent(key, it.calendar, it.event, "planned", it.recurring));
      }
    }
  }
  return state;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderCalendarTable(events: CalEvent[]): string {
  return [
    BEGIN,
    "_Google カレンダーから自動生成（`kb calendar import` が書き換える区間。メモは下の `## メモ` に書く）_", "",
    "| 日付 | 時間 | 予定 | カレンダー | 状態 |",
    "|---|---|---|---|---|",
    ...events.map((e) => `| ${e.date} | ${e.start ? `${e.start}–${e.end}` : "終日"} | ${cell(e.title)}${e.location ? ` @${cell(e.location)}` : ""}${e.recurring ? `（繰り返し ${e.recurring.count} 回、〜${e.recurring.last}）` : ""} | ${cell(e.calendar)} | ${e.status === "done" ? "実績" : "予定"} |`),
    END,
  ].join("\n");
}

export interface CalendarImportResult { bronzeId: string; months: { path: string; created: boolean; done: number; planned: number }[] }

export function importCalendar(cfg: KbConfig, reg: SchemaRegistry, db: Database, bronzeId: string): CalendarImportResult {
  const meta = readMeta(cfg, bronzeId);
  if (!meta || !meta.files.some(isCalendarFeed)) throw new Error(`${bronzeId} is not a collect-calendar feed in Bronze`);
  if (!reg.get("calendar_log")) throw new Error("schema calendar_log.json missing");

  const metas = [...walkBronze(cfg)].filter((m) => m.kind === "feed" && m.files.some(isCalendarFeed)).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const read = (id: string, files: string[]) => JSON.parse(readFileSync(join(bronzeDir(cfg, id), files.find(isCalendarFeed)!), "utf8")) as Feed<CalendarItem>;
  const state = replayCalendar(metas.map((m) => read(m.id, m.files)));

  const byMonth = new Map<string, CalEvent[]>();
  for (const e of state.values()) {
    const m = e.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(e);
  }
  const existing = new Map<string, string>();
  for (const n of runQuery(db, { filters: [{ field: "type", op: "=", value: "calendar_log" }], limit: 10000 })) existing.set(String(n.fm.month ?? ""), n.path);
  // months this feed touched, plus months whose events may have moved or vanished: rebuild every month in either set
  const months = [...new Set([...byMonth.keys(), ...existing.keys()])].filter(Boolean).sort();
  const touched = new Set(read(bronzeId, meta.files).items.map((it) => {
    if (!("when" in it) || it.when === "past" || it.change !== "removed") return localDate((it as { event: EventItem }).event.start.dateTime ?? (it as { event: EventItem }).event.start.date ?? "").slice(0, 7);
    return localDate(it.start).slice(0, 7);
  }));

  const result: CalendarImportResult = { bronzeId, months: [] };
  for (const month of months) {
    const events = (byMonth.get(month) ?? []).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
    let rel = existing.get(month), created = false;
    if (!rel || !existsSync(join(cfg.root, rel))) {
      if (!events.length) continue;
      rel = createNote(cfg, reg, db, { type: "calendar_log", title: monthlyTitle("calendar_log", month), set: { month } });
      created = true;
    }
    const abs = join(cfg.root, rel);
    const { fm, body } = parseNote(readFileSync(abs, "utf8"));
    const block = renderCalendarTable(events);
    const b = body.indexOf(BEGIN), e = body.indexOf(END);
    let newBody: string;
    if (b !== -1 && e > b) newBody = body.slice(0, b) + block + body.slice(e + END.length);
    else {
      const h = /^## 予定\s*\n/m.exec(body) ?? /^# .*\n/m.exec(body);
      const at = h ? h.index + h[0].length : 0;
      newBody = body.slice(0, at) + "\n" + block + "\n" + body.slice(at);
    }
    const done = events.filter((x) => x.status === "done").length, planned = events.length - done;
    const before = JSON.stringify(fm.events ?? []);
    Object.assign(fm, {
      month, done, planned, events,
      summary: `${month.replace("-", "年").replace(/^(\d+年)0?/, "$1")}月の予定（実績 ${done} 件・予定 ${planned} 件）`,
    });
    if (created || before !== JSON.stringify(events)) fm.updated = today();
    if (touched.has(month)) fm.sources = [...new Set([...(Array.isArray(fm.sources) ? fm.sources.map(String) : []), bronzeId])];
    writeFileSync(abs, stringifyNote(fm, newBody));
    if (touched.has(month)) markProcessed(cfg, bronzeId, [rel]);
    result.months.push({ path: rel, created, done, planned });
  }
  if (!result.months.some((m) => touched.has(m.path.split("/").pop()!.slice(0, 7)))) markProcessed(cfg, bronzeId, ["-"]);
  return result;
}
