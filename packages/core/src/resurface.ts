/**
 * Resurfacing: knowledge that was written but is not coming back on its own. One function computes it from the
 * index; `kb build` renders it as the plaintext Gold view 393 (and a section of the home page), the API's home
 * shows it with titles, and the morning ops digest carries the count.
 *
 *   due        review_due (finance_account / stock / theme) within REVIEW_SOON_DAYS or past,
 *              learning notes not reviewed for LEARNING_REVIEW_DAYS, and lint's stale rule
 *              (active project / learning untouched for STALE_DAYS)
 *   onThisDay  notes created (or dated) on today's month-day in an earlier year
 *   random     RANDOM_COUNT plaintext notes, seeded by the date so a day shows the same three
 *   articles   read-later articles (900_system/articles) queued LATER_STALE_DAYS or longer: decide, never auto-dropped
 *
 * Encrypted domains (git-crypt) are included with `encrypted: true`; the plaintext renderers print them as counts only.
 */
import type { Database } from "bun:sqlite";
import { GOLD, SILVER_PREFIX, isEncryptedPath, encryptedDomainOf, type KbConfig } from "./config";
import { LATER_STALE_DAYS, daysBetween, listLaterArticles } from "./articles";
import { runQuery, type QueryResult } from "./query";

export const REVIEW_SOON_DAYS = 14;
export const LEARNING_REVIEW_DAYS = 60;
/** lint's stale rule (shared with maintain.ts): an active project / learning note untouched this long. */
export const STALE_DAYS = 30;
export const RANDOM_COUNT = 3;

export interface ResurfaceEntry {
  path: string; type: string; title: string; status: string; summary: string;
  /** Lives in a git-crypt domain: plaintext output shows it by count only. */
  encrypted: boolean;
  /** `due`: why it is listed. `onThisDay`: the year. */
  reason: string;
  /** `due`: the date that triggered it (review_due / last_reviewed / updated). `onThisDay`: the original date. */
  date: string;
  overdue?: boolean;
}
/** A read-later article that has waited LATER_STALE_DAYS or more (public URL and title: fine in plaintext). */
export interface ResurfaceArticle {
  /** Day file it lives in, and its id there (what POST /api/articles/react takes). */
  date: string; id: string;
  title: string; url: string; feed: string;
  /** Queued on (date) and for how many days. */
  since: string; days: number;
  opened: boolean;
}
export interface Resurface {
  date: string;
  due: ResurfaceEntry[];
  onThisDay: ResurfaceEntry[];
  random: ResurfaceEntry[];
  /** Empty when no cfg was given (the digest's count-only use). */
  articles: ResurfaceArticle[];
}

const DAY = 86_400_000;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

/** True when lint should flag the note as stale (active project / learning, `updated` older than `days`). */
export function isStale(n: { type: string; status: string; updated: string }, todayStr: string, days = STALE_DAYS): boolean {
  return ["project", "learning"].includes(n.type) && n.status === "active" && isDate(n.updated) && daysBetween(n.updated.slice(0, 10), todayStr) > days;
}

function entry(n: QueryResult, reason: string, date: string, overdue?: boolean): ResurfaceEntry {
  return { path: n.path, type: n.type, title: n.title, status: n.status, summary: n.summary, encrypted: isEncryptedPath(n.path), reason, date, ...(overdue !== undefined ? { overdue } : {}) };
}

/** Notes due for a look: one entry per note, reasons joined when several apply. Overdue first, then by date. */
export function dueNotes(notes: QueryResult[], todayStr: string): ResurfaceEntry[] {
  const soon = addDays(todayStr, REVIEW_SOON_DAYS);
  const out = new Map<string, ResurfaceEntry>();
  const add = (n: QueryResult, reason: string, date: string, overdue: boolean) => {
    const prev = out.get(n.path);
    if (prev) { prev.reason += `・${reason}`; prev.overdue = prev.overdue || overdue; if (date < prev.date) prev.date = date; }
    else out.set(n.path, entry(n, reason, date, overdue));
  };
  for (const n of notes) {
    if (isDate(n.fm.review_due)) {
      const d = String(n.fm.review_due).slice(0, 10);
      if (d <= soon) add(n, d < todayStr ? `見直し期限 ${d}（${daysBetween(d, todayStr)} 日超過）` : d === todayStr ? "見直し期限 今日" : `見直し期限 ${d}`, d, d < todayStr);
    }
    if (n.type === "learning" && n.status === "active") {
      const last = isDate(n.fm.last_reviewed) ? String(n.fm.last_reviewed).slice(0, 10) : null;
      const since = last ?? (isDate(n.updated) ? n.updated.slice(0, 10) : null);
      if (since && daysBetween(since, todayStr) > LEARNING_REVIEW_DAYS) add(n, last ? `最終復習 ${last}（${daysBetween(last, todayStr)} 日前）` : `復習の記録なし（更新 ${since}）`, since, false);
    }
    if (isStale(n, todayStr)) add(n, `${STALE_DAYS} 日以上更新なし（${n.updated.slice(0, 10)}）`, n.updated.slice(0, 10), false);
  }
  return [...out.values()].sort((a, b) => Number(!a.overdue) - Number(!b.overdue) || a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
}

/** Notes whose `created` (or `date`) falls on today's month-day in an earlier year, newest year first. */
export function onThisDay(notes: QueryResult[], todayStr: string): ResurfaceEntry[] {
  const md = todayStr.slice(5, 10), year = todayStr.slice(0, 4);
  const out: ResurfaceEntry[] = [];
  for (const n of notes) {
    const d = [n.fm.date, n.fm.created].find(isDate);
    if (!d) continue;
    const day = d.slice(0, 10);
    if (day.slice(5) === md && day.slice(0, 4) < year) out.push(entry(n, `${day.slice(0, 4)} 年`, day));
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
}

/**
 * Deterministic picks: the same date (seed) gives the same notes whatever the index order. Spread over types when
 * possible (books are most of the index; three Kobo imports in a row say little), then filled in shuffled order.
 */
export function seededPick<T extends { path: string; type?: string }>(items: T[], seed: string, count = RANDOM_COUNT): T[] {
  const pool = [...items].sort((a, b) => a.path.localeCompare(b.path));
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const rand = () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffled: T[] = [];
  while (pool.length) shuffled.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  const out: T[] = [];
  const types = new Set<string>();
  for (const it of shuffled) if (out.length < count && !types.has(it.type ?? "")) { out.push(it); types.add(it.type ?? ""); }
  for (const it of shuffled) if (out.length < count && !out.includes(it)) out.push(it);
  return out;
}

export function resurface(db: Database, todayStr: string, cfg?: KbConfig): Resurface {
  const notes = runQuery(db, { filters: [], limit: 100000 }).filter((n) => n.path.startsWith(SILVER_PREFIX));
  const due = dueNotes(notes, todayStr);
  const today = onThisDay(notes, todayStr);
  const taken = new Set([...due, ...today].map((e) => e.path));
  // random picks are plaintext only: a count would say nothing, and the plaintext Gold must not name encrypted notes
  const random = seededPick(notes.filter((n) => !taken.has(n.path) && !isEncryptedPath(n.path)), todayStr).map((n) => entry(n, "", ""));
  return { date: todayStr, due, onThisDay: today, random, articles: cfg ? staleLaterArticles(cfg, todayStr) : [] };
}

/** Read-later articles queued LATER_STALE_DAYS or longer, the longest-waiting first. */
export function staleLaterArticles(cfg: KbConfig, todayStr: string): ResurfaceArticle[] {
  return listLaterArticles(cfg, { olderThanDays: LATER_STALE_DAYS, now: new Date(`${todayStr}T12:00:00Z`) }).map(({ date, item }) => {
    const since = (item.later_at ?? date).slice(0, 10);
    return { date, id: item.id, title: item.title, url: item.url, feed: item.feed, since, days: daysBetween(since, todayStr), opened: !!item.opened_at };
  });
}

/** Entries whose titles may appear in a plaintext file, and the per-domain counts of the rest. */
export function splitEncrypted(entries: ResurfaceEntry[]): { plain: ResurfaceEntry[]; encrypted: [string, number][] } {
  const c = new Map<string, number>();
  for (const e of entries) { const d = encryptedDomainOf(e.path); if (d) c.set(d, (c.get(d) ?? 0) + 1); }
  return { plain: entries.filter((e) => !e.encrypted), encrypted: [...c.entries()].sort(([a], [b]) => a.localeCompare(b)) };
}

const mdDate = (d: string) => { const [, m, day] = d.split("-"); return `${Number(m)}/${Number(day)}`; };
const link = (e: ResurfaceEntry) => `[${e.title.replace(/\|/g, "\\|")}](../${e.path})`;
const encryptedLine = (enc: [string, number][], hint: string) => enc.length ? [`暗号化ドメイン: ${enc.map(([d, c]) => `${d} ${c} 件`).join("、")}（${hint}）`] : [];
const withSummary = (e: ResurfaceEntry) => `${link(e)}${e.summary ? ` — ${e.summary}` : ""}`;

/** 393_resurface.md (plaintext: encrypted domains by count only). */
export function renderResurface(r: Resurface): string {
  const due = splitEncrypted(r.due), today = splitEncrypted(r.onThisDay);
  return [
    "# 見直し", "",
    `${r.date} 時点。書いたまま見返していないノートを毎日入れ替えて出す。見直し期限は \`review_due\`（口座・銘柄・テーマ、${REVIEW_SOON_DAYS} 日先まで）、学習ノートの \`last_reviewed\`（${LEARNING_REVIEW_DAYS} 日）、${STALE_DAYS} 日以上更新のない進行中のプロジェクト・学習（\`kb lint\` の stale）、${LATER_STALE_DAYS} 日以上そのままの「後で読む」記事。暗号化ドメイン（202/203/207/210/211/212）は件数だけ: 内容は WebUI のホームか \`kb query\` で。`, "",
    "## 見直し期限", "",
    "| 期限 | ノート | 理由 | 要約 |", "|---|---|---|---|",
    ...(due.plain.length ? due.plain.map((e) => `| ${e.overdue ? `**${e.date}（超過）**` : e.date} | ${link(e)} | ${e.reason} | ${e.summary.replace(/\|/g, "\\|")} |`) : ["| （なし） | | | |"]),
    ...encryptedLine(due.encrypted, `\`kb query review_due<=${addDays(r.date, REVIEW_SOON_DAYS)}\``),
    "", `## 同じ月日の過去ノート（${r.date.slice(5).replace("-", "/")}）`, "",
    ...(today.plain.length ? today.plain.map((e) => `- ${e.reason}: ${withSummary(e)}`) : ["- （なし）"]),
    ...encryptedLine(today.encrypted, "`created` が同じ月日"),
    "", `## 読むか捨てるか決める記事（${r.articles.length} 件）`, "",
    `「後で読む」に入れて ${LATER_STALE_DAYS} 日以上たった記事。期限で自動処理はしない: WebUI の「記事」で「取り込む」「読んだ」「興味なし」のどれかを押す（\`kb articles later --days ${LATER_STALE_DAYS}\`）。`, "",
    ...(r.articles.length ? r.articles.map((a) => `- [${a.title.replace(/\|/g, "\\|")}](${a.url}) — ${a.feed} — ${mdDate(a.since)} から ${a.days} 日${a.opened ? "・開いた" : ""}`) : ["- （なし）"]),
    "", `## 今日のランダム ${RANDOM_COUNT} 件`, "",
    "日付を種にして選ぶので、同じ日は何度 `kb build` しても同じ 3 件。", "",
    ...(r.random.length ? r.random.map((e) => `- ${withSummary(e)}（${e.type}）`) : ["- （なし）"]),
  ].join("\n");
}

/** The home page's section: counts, a link to 393 and the first few plaintext entries. */
export function renderResurfaceHome(r: Resurface, goldRel = GOLD.resurface): string[] {
  const due = splitEncrypted(r.due), today = splitEncrypted(r.onThisDay);
  const enc = (xs: [string, number][]) => xs.reduce((a, [, c]) => a + c, 0);
  const lines = [
    "## 今日見直す", "",
    `[見直し](${goldRel}) — 期限 ${r.due.length} 件${enc(due.encrypted) ? `（うち暗号化ドメイン ${enc(due.encrypted)}）` : ""} / 同じ月日 ${r.onThisDay.length} 件 / ランダム ${r.random.length} 件${r.articles.length ? ` / 放置中の記事 ${r.articles.length} 件` : ""}`, "",
    ...due.plain.slice(0, 5).map((e) => `- ${e.overdue ? "**超過** " : ""}${link(e)} — ${e.reason}`),
    ...(due.plain.length > 5 ? [`- …他 ${due.plain.length - 5} 件は [見直し](${goldRel})`] : []),
    ...today.plain.slice(0, 3).map((e) => `- ${e.reason}の今日: ${link(e)}`),
    ...r.random.map((e) => `- ランダム: ${link(e)}`),
    ...(r.articles.length ? [`- 後で読む: ${r.articles.length} 件が ${LATER_STALE_DAYS} 日以上そのまま（最長 ${r.articles[0]!.days} 日）。読むか捨てるかは [記事](${GOLD.articles}) で`] : []),
  ];
  return lines;
}
