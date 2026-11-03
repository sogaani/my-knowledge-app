/**
 * Work view: tasks across projects (with due dates), the work calendar, recent project activity, the weekly 1on1 prep
 * and the glossary — Gold 394_work.md (git-crypt encrypted: it names work projects and tasks), `kb tasks`, and the
 * counts on the morning ops digest.
 *
 * Tasks are the checkbox lines of a project's tasks.md. A due date is written in the line as `（期限 2026-11-13）`
 * (also accepted: `期限: 2026-11-13`, `due:2026-11-13`). Work = `area: work`, or a project in 200_silver/207_work without
 * `area: personal`.
 * Work calendar events are the calendar_log events from the extra Google account named `work` (CalEvent.account).
 * A work project folder may also hold `1on1.md` (weekly blocks `### YYYY-Www …` written by the work-weekly skill) and
 * `glossary.md` (`- **用語**: 説明` lines).
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CalEvent } from "./calendar";
import { WORK_FOLDER, type KbConfig } from "./config";
import { runQuery, type QueryResult } from "./query";
import { logEntries } from "./views";

export const WORK_ACCOUNT = "work";
/** Project statuses whose tasks count as open work. */
const LIVE = ["active", "planned", "paused", "idea"];
export const DUE_SOON_DAYS = 7;
export const RECENT_DAYS = 7;

export interface Task { done: boolean; text: string; due?: string; line: number }
export interface ProjectTask extends Task { project: QueryResult; tasksPath: string }

const DUE_RE = /[（(]?\s*(?:期限|due)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})\s*[）)]?/i;

/** Checkbox lines of a tasks.md. The due date is lifted out of the text. */
export function parseTasks(text: string): Task[] {
  const out: Task[] = [];
  text.split("\n").forEach((l, i) => {
    const m = /^\s*[-*] \[([ xX])\] (.+)$/.exec(l);
    if (!m) return;
    const due = DUE_RE.exec(m[2]!);
    const body = (due ? m[2]!.replace(due[0], "") : m[2]!).replace(/\s+/g, " ").trim();
    out.push({ done: m[1] !== " ", text: body, ...(due ? { due: due[1]! } : {}), line: i + 1 });
  });
  return out;
}

/** `area` decides when it is set (a private matter can live in the encrypted 207_work, e.g. a pension transfer); else the folder. */
export const isWorkProject = (n: QueryResult) => (n.fm.area === "work" || n.fm.area === "personal" ? n.fm.area === "work" : n.path.startsWith(`${WORK_FOLDER}/`));

const projects = (db: Database) =>
  runQuery(db, { filters: [{ field: "type", op: "=", value: "project" }], limit: 100000 }).filter((n) => LIVE.includes(n.status) && !n.path.includes("/_archive/"));

/** Open (or all) tasks of the live projects, optionally only work / personal ones. */
export function collectTasks(cfg: KbConfig, db: Database, opts: { area?: "work" | "personal"; includeDone?: boolean } = {}): ProjectTask[] {
  const out: ProjectTask[] = [];
  for (const n of projects(db)) {
    if (opts.area === "work" && !isWorkProject(n)) continue;
    if (opts.area === "personal" && isWorkProject(n)) continue;
    const tasksPath = join(dirname(n.path), "tasks.md");
    const abs = join(cfg.root, tasksPath);
    if (!existsSync(abs)) continue;
    for (const t of parseTasks(readFileSync(abs, "utf8"))) if (opts.includeDone || !t.done) out.push({ ...t, project: n, tasksPath });
  }
  return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.project.title.localeCompare(b.project.title) || a.line - b.line);
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** "期限切れ 3 日" / "今日" / "あと 4 日". */
export function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due);
  return d < 0 ? `期限切れ ${-d} 日` : d === 0 ? "今日" : `あと ${d} 日`;
}

/** A shared / subscribed calendar (team calendar, holidays): its id is `…@group.calendar.google.com` / `…@group.v.calendar.google.com`. */
export const isGroupCalendar = (e: CalEvent) => /@group(\.v)?\.calendar\.google\.com\|/.test(e.key);

/**
 * calendar_log events of the work account, from my own calendars only: a team calendar carries everyone's leave and
 * the same meetings again, which would bury mine.
 */
export function workEvents(db: Database): CalEvent[] {
  const out: CalEvent[] = [];
  for (const n of runQuery(db, { filters: [{ field: "type", op: "=", value: "calendar_log" }], limit: 100000 }))
    for (const e of (Array.isArray(n.fm.events) ? n.fm.events : []) as CalEvent[]) if (e.account === WORK_ACCOUNT && !isGroupCalendar(e)) out.push(e);
  return out;
}

/** Non-recurring events on these dates, and the recurring series running on `today` (their exact days are not known). */
export function agenda(events: CalEvent[], today: string, days = 2): { dated: CalEvent[]; series: CalEvent[] } {
  const until = addDays(today, days - 1);
  const dated = events.filter((e) => !e.recurring && e.date >= today && e.date <= until).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const seen = new Set<string>();
  const series = events
    .filter((e) => e.status === "planned" && e.recurring && e.recurring.first <= until && e.recurring.last >= today)
    .filter((e) => (seen.has(e.title) ? false : (seen.add(e.title), true)))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { dated, series };
}

export interface WorkSummary { open: number; overdue: number; dueSoon: number; meetingsToday: number }

export function workSummary(cfg: KbConfig, db: Database, today: string): WorkSummary | null {
  const live = projects(db).filter(isWorkProject);
  if (!live.length) return null;
  const tasks = collectTasks(cfg, db, { area: "work" });
  const soon = addDays(today, DUE_SOON_DAYS);
  return {
    open: tasks.length,
    overdue: tasks.filter((t) => t.due && t.due < today).length,
    dueSoon: tasks.filter((t) => t.due && t.due >= today && t.due <= soon).length,
    meetingsToday: agenda(workEvents(db), today, 1).dated.length,
  };
}

/** `### 2026-W45（11-03〜11-07）` blocks of a 1on1.md: the newest heading. */
export function latestWeek(text: string): string | null {
  const weeks = [...text.matchAll(/^###\s+(\d{4}-W\d{2}.*)$/gm)].map((m) => m[1]!.trim());
  return weeks.sort().at(-1) ?? null;
}
export const glossaryCount = (text: string) => (text.match(/^[-*]\s+\*\*[^*]+\*\*/gm) ?? []).length;

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const link = (path: string, label: string) => `[${cell(label)}](../${path})`;

export function renderWork(cfg: KbConfig, db: Database, today: string): string {
  const live = projects(db).filter(isWorkProject);
  const tasks = collectTasks(cfg, db, { area: "work" });
  const soon = addDays(today, DUE_SOON_DAYS);
  const dated = tasks.filter((t) => t.due && t.due <= soon);
  const undated = tasks.filter((t) => !t.due || t.due > soon);
  const { dated: meetings, series } = agenda(workEvents(db), today, 2);
  const since = addDays(today, -RECENT_DAYS + 1);
  const recent: { date: string; text: string; project: QueryResult }[] = [];
  const extras: string[] = [];
  for (const n of live) {
    const dir = dirname(n.path);
    const log = join(cfg.root, dir, "log.md");
    if (existsSync(log)) for (const e of logEntries(readFileSync(log, "utf8"))) if (e.date >= since && e.date <= today) recent.push({ ...e, project: n });
    const oneOnOne = join(cfg.root, dir, "1on1.md");
    if (existsSync(oneOnOne)) {
      const w = latestWeek(readFileSync(oneOnOne, "utf8"));
      if (w) extras.push(`- 週次ふりかえり・1on1 準備: ${link(`${dir}/1on1.md`, w)}（${cell(n.title)}）`);
    }
    const glossary = join(cfg.root, dir, "glossary.md");
    if (existsSync(glossary)) extras.push(`- 用語集: ${link(`${dir}/glossary.md`, `${glossaryCount(readFileSync(glossary, "utf8"))} 語`)}（${cell(n.title)}）`);
  }
  recent.sort((a, b) => b.date.localeCompare(a.date));
  const proj = (t: ProjectTask) => link(t.tasksPath, t.project.title);
  const byProject = new Map<string, ProjectTask[]>();
  for (const t of undated) byProject.set(t.tasksPath, [...(byProject.get(t.tasksPath) ?? []), t]);
  return [
    "# 仕事", "",
    `${today} 時点。207_work と \`area: work\` のプロジェクトの tasks.md・log.md と、仕事のカレンダー（アカウント ${WORK_ACCOUNT}。自分のカレンダーだけで、チームの共有カレンダーは除く）から。期限は tasks.md の行に \`（期限 YYYY-MM-DD）\` と書く。一覧は \`kb tasks --area work\`。`, "",
    `## 期限切れ・${DUE_SOON_DAYS} 日以内のタスク`, "",
    "| 期限 | | タスク | プロジェクト |", "|---|---|---|---|",
    ...(dated.length ? dated.map((t) => `| ${t.due! < today ? `**${t.due}**` : t.due} | ${dueLabel(t.due!, today)} | ${cell(t.text)} | ${proj(t)} |`) : ["| （なし） | | | |"]), "",
    "## 今日・明日の予定", "",
    "| 日付 | 時間 | 予定 |", "|---|---|---|",
    ...(meetings.length ? meetings.map((e) => `| ${e.date === today ? "今日" : "明日"} | ${e.start ? `${e.start}–${e.end}` : "終日"} | ${cell(e.title)} |`) : ["| （なし） | | |"]),
    ...(series.length ? ["", `定例（期間中。実際の日は Google カレンダーで）: ${series.map((e) => `${e.start ? `${e.start} ` : ""}${cell(e.title)}`).join("、")}`] : []), "",
    "## その他の未完了タスク", "",
    ...(byProject.size
      ? [...byProject.values()].flatMap((ts) => [`### ${proj(ts[0]!)}（${ts.length}）`, ...ts.map((t) => `- ${cell(t.text)}${t.due ? `（期限 ${t.due}）` : ""}`), ""])
      : ["（なし）", ""]),
    `## 直近 ${RECENT_DAYS} 日の動き`, "",
    "| 日付 | プロジェクト | 内容 |", "|---|---|---|",
    ...(recent.length ? recent.map((e) => `| ${e.date} | ${link(e.project.path, e.project.title)} | ${cell(e.text.length > 160 ? `${e.text.slice(0, 160)}…` : e.text)} |`) : ["| （なし） | | |"]), "",
    "## ふりかえり・用語", "",
    ...(extras.length ? extras : ["- （まだない。週次の `work-weekly` が `1on1.md` を、`ingest` が `glossary.md` を書く）"]),
    "",
    `進行中の仕事プロジェクト: ${live.map((n) => link(n.path, n.title)).join("、") || "なし"}`,
  ].join("\n");
}

