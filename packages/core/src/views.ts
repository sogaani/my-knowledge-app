/**
 * Cross-domain Gold views (39x: views that span domains, so they do not take a domain number):
 *   390_daily     one row per day: steps / sleep (210), places (211), spending (203 ledger), calendar (212),
 *                 books / media finished (204 / 205), project log entries (206 / 207)
 *   391_trends    one row per month: averages and counts across the same sources
 *   392_upcoming  the next 90 days: planned events (212), project due dates (206 / 207), renewals (202), reviews (203)
 * Everything is read from Silver (frontmatter, plus the ledger 明細 table and project log.md files), never from Bronze,
 * so the API pod can rebuild them too. They mix encrypted domains, so the data repo encrypts all three.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { KbConfig } from "./config";
import { parseNote } from "./frontmatter";
import { runQuery, type QueryResult } from "./query";
import type { CalEvent } from "./calendar";

export const DAILY_DAYS = 60;
export const TREND_MONTHS = 12;
export const UPCOMING_DAYS = 90;

/** Place categories for the trends (Places API primaryType → group). */
export const PLACE_GROUPS: { label: string; match: (t: string) => boolean }[] = [
  { label: "運動", match: (t) => /^(gym|fitness_center|bouldering_gym|climbing_gym|sports_club|sports_complex|swimming_pool|yoga_studio|golf_course|ski_resort)$/.test(t) },
  { label: "文化", match: (t) => /^(museum|art_museum|art_gallery|history_museum|science_museum|movie_theater|performing_arts_theater|concert_hall|opera_house|library|cultural_center)$/.test(t) },
  { label: "外食", match: (t) => /restaurant$|^(cafe|coffee_shop|bar|pub|izakaya|bakery|cafeteria|food_court|tea_house)$/.test(t) },
];

const DAY = 86_400_000;
const ymd = (d: Date) => d.toLocaleDateString("sv-SE");
const addDays = (d: string, n: number) => ymd(new Date(new Date(`${d}T00:00:00`).getTime() + n * DAY));
const hm = (min: unknown) => (typeof min === "number" ? `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, "0")}m` : "");
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n)}…` : s);
const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
const link = (n: QueryResult, label = n.title) => `[${cell(label)}](../${n.path})`;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

/** Ledger 明細 rows: | 日付 | 内容 | 金額 | 区分 | 支払手段 | 出典 |. 収入 and 振替 are not spending. */
export function ledgerSpending(body: string): { date: string; amount: number }[] {
  const out: { date: string; amount: number }[] = [];
  const sec = /^## 明細\s*$/m.exec(body);
  if (!sec) return out;
  const end = body.indexOf("\n## ", sec.index + 1);
  for (const line of body.slice(sec.index, end === -1 ? undefined : end).split("\n")) {
    const c = line.split("|").map((x) => x.trim());
    if (c.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(c[1]!)) continue;
    if (/^(収入|振替)$/.test(c[4]!)) continue;
    const amount = Number(c[3]!.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(amount) && amount > 0) out.push({ date: c[1]!, amount });
  }
  return out;
}

/** Dated entries of a project log.md: "## YYYY-MM-DD" headings with bullets, or "- YYYY-MM-DD: text" lines. */
export function logEntries(text: string): { date: string; text: string }[] {
  const out: { date: string; text: string }[] = [];
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const h = /^##\s+(\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (h) { current = h[1]!; continue; }
    if (/^##\s/.test(line)) { current = null; continue; }
    const dated = /^[-*]\s+(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.+)$/.exec(line);
    if (dated) { out.push({ date: dated[1]!, text: dated[2]!.trim() }); continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet && current) out.push({ date: current, text: bullet[1]!.trim() });
  }
  return out;
}

interface Collected {
  health: Map<string, Record<string, number>>;
  places: Map<string, { visits: number; places: string[]; types: string[] }>;
  spending: Map<string, number>;
  events: (CalEvent & { note: QueryResult })[];
  finished: { date: string; kind: "本" | "映像"; note: QueryResult }[];
  logs: { date: string; text: string; note: QueryResult }[];
  healthMonths: QueryResult[];
  placeMonths: QueryResult[];
  ledgers: QueryResult[];
}

function collect(cfg: KbConfig, db: Database): Collected {
  const q = (type: string) => runQuery(db, { filters: [{ field: "type", op: "=", value: type }], limit: 100000 });
  const c: Collected = { health: new Map(), places: new Map(), spending: new Map(), events: [], finished: [], logs: [], healthMonths: q("health_log"), placeMonths: q("location_log"), ledgers: q("ledger") };
  for (const n of c.healthMonths) for (const [d, v] of Object.entries(obj<Record<string, number>>(n.fm.daily))) c.health.set(d, v);
  for (const n of c.placeMonths) for (const [d, v] of Object.entries(obj<{ visits: number; places: string[]; types: string[] }>(n.fm.daily))) c.places.set(d, v);
  for (const n of c.ledgers) {
    const abs = join(cfg.root, n.path);
    if (!existsSync(abs)) continue;
    for (const r of ledgerSpending(parseNote(readFileSync(abs, "utf8")).body)) c.spending.set(r.date, (c.spending.get(r.date) ?? 0) + r.amount);
  }
  for (const n of q("calendar_log")) for (const e of (Array.isArray(n.fm.events) ? n.fm.events : []) as CalEvent[]) c.events.push({ ...e, note: n });
  for (const n of q("book")) if (isDate(n.fm.finished_at)) c.finished.push({ date: String(n.fm.finished_at).slice(0, 10), kind: "本", note: n });
  for (const n of q("media")) if (isDate(n.fm.watched_at)) c.finished.push({ date: String(n.fm.watched_at).slice(0, 10), kind: "映像", note: n });
  for (const n of q("project")) {
    const log = join(cfg.root, dirname(n.path), "log.md");
    if (existsSync(log)) for (const e of logEntries(readFileSync(log, "utf8"))) c.logs.push({ ...e, note: n });
  }
  return c;
}

export function renderDaily(c: Collected, todayStr: string): string {
  const from = addDays(todayStr, -(DAILY_DAYS - 1));
  const rows: string[] = [];
  for (let d = todayStr; d >= from; d = addDays(d, -1)) {
    const h = c.health.get(d), p = c.places.get(d), spend = c.spending.get(d);
    const ev = c.events.filter((e) => e.date === d && e.status === "done");
    const fin = c.finished.filter((f) => f.date === d);
    const logs = c.logs.filter((l) => l.date === d);
    if (!h && !p && !spend && !ev.length && !fin.length && !logs.length) continue;
    rows.push([
      d,
      h?.steps !== undefined ? h.steps.toLocaleString("ja-JP") : "",
      hm(h?.sleep_min),
      p ? cell(p.places.slice(0, 3).map((x) => short(x, 16)).join("、")) + (p.places.length > 3 ? ` ほか ${p.places.length - 3}` : "") : "",
      spend ? yen(spend) : "",
      ev.map((e) => cell(short(e.title, 20))).join("、"),
      fin.map((f) => `${f.kind}: ${link(f.note, short(f.note.title, 20))}`).join("、"),
      [...new Map(logs.map((l) => [l.note.path, l])).values()].map((l) => `${link(l.note, short(l.note.title, 16))}: ${cell(short(l.text))}`).join("<br>"),
    ].join(" | "));
  }
  return [
    "# ライフログ", "",
    `直近 ${DAILY_DAYS} 日の 1 日 1 行（データのある日だけ）。歩数・睡眠は健康記録、場所は滞在記録、支出は月次台帳（収入・振替を除く）、予定はカレンダーの実績、本・映像は読了日・視聴日、プロジェクトはログから。`, "",
    "| 日付 | 歩数 | 睡眠 | 主な滞在 | 支出 | 予定 | 本・映像 | プロジェクト |", "|---|---|---|---|---|---|---|---|",
    ...(rows.length ? rows.map((r) => `| ${r} |`) : ["| （なし） | | | | | | | |"]),
  ].join("\n");
}

export function renderTrends(c: Collected, todayStr: string): string {
  const months: string[] = [];
  for (let i = 0; i < TREND_MONTHS; i++) {
    const d = new Date(`${todayStr.slice(0, 7)}-01T00:00:00`);
    d.setMonth(d.getMonth() - i);
    months.push(ymd(d).slice(0, 7));
  }
  const byMonth = <T extends { fm: Record<string, unknown> }>(xs: T[]) => new Map(xs.map((n) => [String(n.fm.month ?? ""), n]));
  const health = byMonth(c.healthMonths), places = byMonth(c.placeMonths), ledgers = byMonth(c.ledgers);
  const rows = months.map((m) => {
    const h = health.get(m), p = places.get(m), l = ledgers.get(m);
    const types = obj<number>(p?.fm.type_counts);
    const group = (g: (typeof PLACE_GROUPS)[number]) => Object.entries(types).filter(([t]) => g.match(t)).reduce((a, [, n]) => a + n, 0);
    const spend = [...c.spending].filter(([d]) => d.startsWith(m)).reduce((a, [, v]) => a + v, 0);
    const cells = [
      typeof h?.fm.avg_steps === "number" ? h.fm.avg_steps.toLocaleString("ja-JP") : "",
      hm(h?.fm.avg_sleep_min),
      ...(p ? PLACE_GROUPS.map((g) => String(group(g))) : PLACE_GROUPS.map(() => "")),
      String(c.finished.filter((f) => f.kind === "本" && f.date.startsWith(m)).length || ""),
      String(c.finished.filter((f) => f.kind === "映像" && f.date.startsWith(m)).length || ""),
      spend ? yen(spend) : l ? yen(Number(l.fm.total ?? 0)) : "",
      String(c.events.filter((e) => e.status === "done" && e.date.startsWith(m)).length || ""),
    ];
    return cells.some((x) => x) ? `| ${m} | ${cells.join(" | ")} |` : null;
  }).filter(Boolean) as string[];
  return [
    "# トレンド", "",
    `直近 ${TREND_MONTHS} か月の推移。${PLACE_GROUPS.map((g) => g.label).join("・")}は滞在記録のジャンル（Places API の primaryType）ごとの滞在回数、支出は月次台帳（収入・振替を除く）、予定はカレンダーの実績件数。`, "",
    `| 月 | 平均歩数 | 平均睡眠 | ${PLACE_GROUPS.map((g) => g.label).join(" | ")} | 読了 | 視聴 | 支出 | 予定 |`,
    `|---|---|---|${PLACE_GROUPS.map(() => "---").join("|")}|---|---|---|---|`,
    ...(rows.length ? rows : [`| （なし） |${" |".repeat(PLACE_GROUPS.length + 7)}`]),
  ].join("\n");
}

export function renderUpcoming(c: Collected, db: Database, cfg: KbConfig, todayStr: string): string {
  const until = addDays(todayStr, UPCOMING_DAYS);
  const q = (type: string) => runQuery(db, { filters: [{ field: "type", op: "=", value: type }], limit: 100000 });
  type Row = { date: string; kind: string; what: string; overdue?: boolean };
  const rows: Row[] = [];
  for (const e of c.events.filter((x) => x.status === "planned")) {
    if (e.recurring) {
      if (e.recurring.last < todayStr || e.recurring.first > until) continue;
      rows.push({ date: e.recurring.first > todayStr ? e.recurring.first : todayStr, kind: "予定（繰り返し）", what: `${cell(e.title)}（〜${e.recurring.last}、${e.recurring.count} 回）· ${cell(e.calendar)}` });
    } else if (e.date >= todayStr && e.date <= until) {
      rows.push({ date: e.date, kind: "予定", what: `${e.start ? `${e.start} ` : ""}${cell(e.title)}${e.location ? ` @${cell(short(e.location, 24))}` : ""} · ${cell(e.calendar)}` });
    }
  }
  for (const n of q("project")) {
    if (!["active", "planned", "paused"].includes(n.status) || !isDate(n.fm.due)) continue;
    const due = String(n.fm.due).slice(0, 10);
    if (due > until) continue;
    const tasks = join(cfg.root, dirname(n.path), "tasks.md");
    const open = existsSync(tasks) ? (readFileSync(tasks, "utf8").match(/^\s*[-*] \[ \] \S/gm) ?? []).length : 0;
    rows.push({ date: due, kind: "期限", what: `${link(n)}${open ? `（未完了タスク ${open}）` : ""}`, overdue: due < todayStr });
  }
  for (const n of q("subscription")) {
    if (n.status !== "active" || !isDate(n.fm.next_renewal)) continue;
    const d = String(n.fm.next_renewal).slice(0, 10);
    if (d >= todayStr && d <= until) rows.push({ date: d, kind: "更新", what: link(n) });
  }
  for (const n of q("finance_account")) {
    if (!isDate(n.fm.review_due)) continue;
    const d = String(n.fm.review_due).slice(0, 10);
    if (d <= until) rows.push({ date: d, kind: "見直し", what: link(n), overdue: d < todayStr });
  }
  rows.sort((a, b) => Number(!a.overdue) - Number(!b.overdue) || a.date.localeCompare(b.date));
  return [
    "# これからの予定", "",
    `${todayStr} から ${UPCOMING_DAYS} 日先まで。予定はカレンダー（繰り返しはまとめて 1 行）、期限は進行中プロジェクトの due、更新はサブスクの次回更新日、見直しは金融口座の見直し期限。過ぎた期限は先頭に出す。`, "",
    "| 日付 | 種類 | 内容 |", "|---|---|---|",
    ...(rows.length ? rows.map((r) => `| ${r.overdue ? `**${r.date}（超過）**` : r.date} | ${r.kind} | ${r.what} |`) : ["| （なし） | | |"]),
  ].join("\n");
}

/** Writes 390 / 391 / 392 through build.ts's `out` (adds the generated-file header). */
export function buildCrossViews(cfg: KbConfig, db: Database, out: (rel: string, text: string) => void, gold: { daily: string; trends: string; upcoming: string }, todayStr = ymd(new Date())) {
  const c = collect(cfg, db);
  out(gold.daily, renderDaily(c, todayStr));
  out(gold.trends, renderTrends(c, todayStr));
  out(gold.upcoming, renderUpcoming(c, db, cfg, todayStr));
}
