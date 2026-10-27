/**
 * Daily article curation from the RSS feeds. The collector drops one `collect-rss-<slug>-…json` per feed into the inbox
 * (title / url / date / head of the summary, no bodies); `curateArticles` moves them to Bronze, builds a compact JSON
 * input (every candidate with its title and ≤ 200 chars of summary, the user's interests, and what happened to earlier
 * picks), hands it to the `curate` skill, which answers with JSON only (`{ picks: [{ id, basis, reason, topics }] }`),
 * and writes the day's file `900_system/articles/YYYY-MM-DD.json` with every candidate (picked or not). The WebUI shows
 * the picks, records `opened` when a link is clicked and `later` / `saved` / `dismissed` from the buttons (`done` closes
 * a `later` item without a note); those reactions feed the next run's `history`. Picks come in two kinds: `fit` (matches the interests / history) and `general` (worth
 * reading whatever the history says — the quota that keeps the loop from narrowing onto what was clicked before).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { LAYOUT, isEncryptedPath, type KbConfig } from "./config";
import { bronzeDir, ingestFile, listInbox, markProcessed, processState, walkBronze, type BronzeMeta } from "./bronze";
import type { Feed } from "./collect/types";
import type { RssEntry } from "./collect/sources/rss";
import { runQuery } from "./query";
import { localDate } from "./wallclock";

export const ARTICLES_DIR = `${LAYOUT.system}/articles`;
export const ARTICLE_PREFS_REL = `${LAYOUT.system}/article-prefs.json`;
export const CURATE_INPUT_REL = `${LAYOUT.system}/cache/curate-in.json`;
export const CURATE_OUTPUT_REL = `${LAYOUT.system}/cache/curate-out.json`;
/** Candidates seen in the last N days are not offered again (feeds re-publish, several feeds carry the same story). */
const DEDUPE_DAYS = 30;
const HISTORY_DAYS = 90;
/** Title lists handed to the agent are capped so the input stays small. */
const HISTORY_TITLES = 30;
const SUMMARY_CHARS = 200;
const REASON_CHARS = 80;
const TOPICS_MAX = 5;
/** A pick nobody opened counts as "ignored" once the day is this old (the morning's list may just not have been read yet). */
const IGNORED_AFTER_DAYS = 2;

export type ArticleBasis = "fit" | "general";
/**
 * opened = the link was clicked (automatic); later = queued to read later (stays until one of the next three);
 * saved = sent to the inbox for ingest; dismissed = not interested; done = read, no note wanted (only from `later`).
 * Nothing expires on its own: a queued article waits until the user reads or drops it.
 */
export type ArticleReaction = "opened" | "later" | "saved" | "dismissed" | "done";
export const ARTICLE_REACTIONS: ArticleReaction[] = ["opened", "later", "saved", "dismissed", "done"];
export type ArticleState = Exclude<ArticleReaction, "opened">;

export interface ArticleItem {
  /** From the URL's sha256 (`articleId`): stable across days and feeds. */
  id: string;
  title: string;
  url: string;
  /** Feed slug (`publickey1-jp`), from the collect file name. */
  feed: string;
  published: string | null;
  summary: string;
  /** Bronze id of the feed file the entry came from. */
  bronze: string;
  picked: boolean;
  basis?: ArticleBasis;
  reason?: string;
  topics?: string[];
  opened_at?: string;
  reaction?: ArticleState;
  reacted_at?: string;
  /** When it entered the read-later queue (kept after saved / dismissed / done, so "queued on" survives). */
  later_at?: string;
}

export interface ArticleDay {
  date: string;
  curated_at: string;
  /** Feed slugs that had candidates. */
  feeds: string[];
  items: ArticleItem[];
  /** What the agent's answer was short of (too few `general` picks, picks dropped over the cap). */
  warnings?: string[];
}

export interface ArticlePrefs {
  /** Picks per day at most. */
  max_per_day: number;
  /** `general` picks at least (the exploration quota). */
  explore_min: number;
  /** Free-text hints added to the interests derived from the notes. */
  interests: string[];
  /** Kinds of articles never worth picking. */
  avoid: string[];
}
const DEFAULT_PREFS: ArticlePrefs = { max_per_day: 8, explore_min: 2, interests: [], avoid: [] };

export interface ArticleHistory {
  /** Days of data behind the counts. */
  days: number;
  /** Per feed slug: how its picks fared, and how many unpicked entries were opened anyway (`missed`). `later` counts the
   * ones still queued or finished from the queue (`done`), i.e. wanted even when not opened the same morning. */
  feeds: Record<string, { candidates: number; picked: number; opened: number; later: number; saved: number; dismissed: number; missed: number }>;
  /** The same per pick kind, to see whether the exploration quota earns its place. */
  basis: Record<ArticleBasis, { picked: number; opened: number; later: number; saved: number; dismissed: number }>;
  /** Recent titles (`title (feed)`), newest first, each list capped. `later` = queued to read later (interest, like saved). */
  opened: string[];
  later: string[];
  saved: string[];
  dismissed: string[];
  /** Opened although not picked: what the curation missed. */
  missed: string[];
  /** Picked but never opened (after a couple of days): what it over-rated. */
  ignored: string[];
}

/** What the `curate` skill reads. URLs are left out on purpose: it judges from titles and summary heads only. */
export interface CurateInput {
  date: string;
  max: number;
  explore_min: number;
  interests: string[];
  avoid: string[];
  history: ArticleHistory;
  items: { id: string; title: string; feed: string; published: string | null; summary: string }[];
}
export interface CuratePick { id: string; basis: ArticleBasis; reason: string; topics: string[] }

/** Letters only (10 of a–z from the URL's sha256): the data repo's pre-commit rejects 7+ digit runs as card-number lookalikes. */
export function articleId(url: string): string {
  let n = BigInt(`0x${createHash("sha256").update(url).digest("hex").slice(0, 16)}`);
  let s = "";
  for (let i = 0; i < 10; i++) { s += String.fromCharCode(97 + Number(n % 26n)); n /= 26n; }
  return s;
}
export const articlePath = (date: string) => `${ARTICLES_DIR}/${date}.json`;

export function readArticleDay(cfg: KbConfig, date: string): ArticleDay | null {
  const abs = join(cfg.root, articlePath(date));
  return existsSync(abs) ? (JSON.parse(readFileSync(abs, "utf8")) as ArticleDay) : null;
}
export function writeArticleDay(cfg: KbConfig, day: ArticleDay): string {
  const rel = articlePath(day.date);
  mkdirSync(join(cfg.root, ARTICLES_DIR), { recursive: true });
  writeFileSync(join(cfg.root, rel), JSON.stringify(day, null, 2) + "\n");
  return rel;
}
/** Dates that have a file, newest first. `before` (exclusive) pages further back. */
export function listArticleDates(cfg: KbConfig, opts: { limit?: number; before?: string } = {}): string[] {
  const dir = join(cfg.root, ARTICLES_DIR);
  if (!existsSync(dir)) return [];
  const dates = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
  const from = opts.before ? dates.filter((d) => d < opts.before!) : dates;
  return opts.limit ? from.slice(0, opts.limit) : from;
}
export function listArticleDays(cfg: KbConfig, opts: { limit?: number; before?: string } = {}): ArticleDay[] {
  return listArticleDates(cfg, opts).map((d) => readArticleDay(cfg, d)).filter((d): d is ArticleDay => !!d);
}

export function loadArticlePrefs(cfg: KbConfig): ArticlePrefs {
  const abs = join(cfg.root, ARTICLE_PREFS_REL);
  if (!existsSync(abs)) return { ...DEFAULT_PREFS };
  const raw = JSON.parse(readFileSync(abs, "utf8")) as Partial<ArticlePrefs>;
  const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? Math.floor(v) : d);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
  return { max_per_day: num(raw.max_per_day, DEFAULT_PREFS.max_per_day), explore_min: num(raw.explore_min, DEFAULT_PREFS.explore_min), interests: list(raw.interests), avoid: list(raw.avoid) };
}

/** Counts for a day's heading, the digest and Gold. `later` = still queued; `done` = read from the queue. */
export function articleStats(day: Pick<ArticleDay, "items">): { candidates: number; picked: number; opened: number; later: number; saved: number; dismissed: number; done: number } {
  const s = { candidates: day.items.length, picked: 0, opened: 0, later: 0, saved: 0, dismissed: 0, done: 0 };
  for (const it of day.items) {
    if (it.picked) s.picked++;
    if (it.opened_at) s.opened++;
    if (it.reaction === "later") s.later++;
    if (it.reaction === "saved") s.saved++;
    if (it.reaction === "dismissed") s.dismissed++;
    if (it.reaction === "done") s.done++;
  }
  return s;
}

/** Queued this long without a decision: 393_resurface and the weekly review list it as "read it or drop it" (never auto-dropped). */
export const LATER_STALE_DAYS = 7;

/**
 * The read-later queue across every day file, oldest queued first. Nothing drops out by age; `olderThanDays` (against
 * `now`'s local date) narrows it to the entries that have been waiting at least that long.
 */
export function listLaterArticles(cfg: KbConfig, opts: { olderThanDays?: number; now?: Date } = {}): { date: string; item: ArticleItem }[] {
  const out: { date: string; item: ArticleItem }[] = [];
  for (const d of listArticleDays(cfg)) for (const item of d.items) if (item.reaction === "later") out.push({ date: d.date, item });
  const queuedOn = (e: { date: string; item: ArticleItem }) => (e.item.later_at ?? e.date).slice(0, 10);
  const list = out.sort((a, b) => queuedOn(a).localeCompare(queuedOn(b)) || (a.item.later_at ?? "").localeCompare(b.item.later_at ?? ""));
  if (opts.olderThanDays === undefined) return list;
  const today = localDate((opts.now ?? new Date()).toISOString());
  return list.filter((e) => daysBetween(queuedOn(e), today) >= opts.olderThanDays!);
}
export const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

const isRssFeed = (m: BronzeMeta) => m.kind === "feed" && /^collect-rss-/.test(m.source);
const feedSlug = (name: string) => /^collect-rss-(.+)-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.exec(name)?.[1] ?? name.replace(/^collect-rss-/, "").replace(/\.json$/, "");

/**
 * Every entry of the RSS feed files not curated yet: inbox files are moved to Bronze first, then the unprocessed rss
 * feeds in Bronze are read. Entries whose id is in `known` (recent days) or repeated within the run are dropped, but
 * every feed file read is returned in `bronzeIds` so the caller can mark it processed even when nothing was new.
 */
export function collectCandidates(cfg: KbConfig, known: Set<string>): { items: ArticleItem[]; bronzeIds: string[] } {
  for (const p of listInbox(cfg)) if (/^collect-rss-.*\.json$/.test(basename(p))) ingestFile(cfg, p, { kind: "feed" });
  const items: ArticleItem[] = [];
  const bronzeIds: string[] = [];
  const seen = new Set(known);
  for (const m of walkBronze(cfg)) {
    if (!isRssFeed(m) || processState(m) !== "unprocessed") continue;
    const file = m.files[0];
    if (!file) continue;
    let feed: Feed<RssEntry>;
    try { feed = JSON.parse(readFileSync(join(bronzeDir(cfg, m.id), file), "utf8")) as Feed<RssEntry>; } catch { continue; }
    if (feed.source !== "rss" || !Array.isArray(feed.items)) continue;
    bronzeIds.push(m.id);
    const slug = typeof feed.meta?.slug === "string" ? feed.meta.slug : feedSlug(m.source);
    for (const e of feed.items) {
      if (!e?.url || !e.title) continue;
      const id = articleId(e.url);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, title: e.title.trim(), url: e.url, feed: slug, published: e.date ? e.date.slice(0, 10) : null, summary: (e.summary ?? "").trim(), bronze: m.id, picked: false });
    }
  }
  items.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? "") || a.feed.localeCompare(b.feed));
  return { items, bronzeIds };
}

/** Ids of every candidate in the last `days` days (dedupe across runs). */
export function knownArticleIds(cfg: KbConfig, days = DEDUPE_DAYS, now = new Date()): Set<string> {
  const since = localDate(new Date(now.getTime() - days * 86400_000).toISOString());
  const ids = new Set<string>();
  for (const d of listArticleDays(cfg)) {
    if (d.date < since) break;
    for (const it of d.items) ids.add(it.id);
  }
  return ids;
}

/** Summarise what happened to earlier picks (and what was opened without being picked) for the agent's input. */
export function buildHistory(days: ArticleDay[], opts: { days?: number; now?: Date } = {}): ArticleHistory {
  const now = opts.now ?? new Date();
  const span = opts.days ?? HISTORY_DAYS;
  const since = localDate(new Date(now.getTime() - span * 86400_000).toISOString());
  const staleBefore = localDate(new Date(now.getTime() - IGNORED_AFTER_DAYS * 86400_000).toISOString());
  const h: ArticleHistory = { days: span, feeds: {}, basis: { fit: zero(), general: zero() }, opened: [], later: [], saved: [], dismissed: [], missed: [], ignored: [] };
  const label = (it: ArticleItem) => `${it.title} (${it.feed})`;
  const push = (list: string[], it: ArticleItem) => { if (list.length < HISTORY_TITLES) list.push(label(it)); };
  for (const d of [...days].sort((a, b) => b.date.localeCompare(a.date))) {
    if (d.date < since) continue;
    for (const it of d.items) {
      const f = (h.feeds[it.feed] ??= { candidates: 0, picked: 0, opened: 0, later: 0, saved: 0, dismissed: 0, missed: 0 });
      f.candidates++;
      const b = it.picked ? h.basis[it.basis ?? "fit"] : null;
      if (it.picked) { f.picked++; b!.picked++; }
      if (it.opened_at) { f.opened++; if (b) b.opened++; push(h.opened, it); if (!it.picked) { f.missed++; push(h.missed, it); } }
      // queued, or read from the queue: wanted. A later → saved / dismissed item is counted under its final state only.
      if (it.reaction === "later" || it.reaction === "done") { f.later++; if (b) b.later++; push(h.later, it); }
      if (it.reaction === "saved") { f.saved++; if (b) b.saved++; push(h.saved, it); }
      if (it.reaction === "dismissed") { f.dismissed++; if (b) b.dismissed++; push(h.dismissed, it); }
      if (it.picked && !it.opened_at && !it.reaction && d.date <= staleBefore) push(h.ignored, it);
    }
  }
  return h;
}
const zero = () => ({ picked: 0, opened: 0, later: 0, saved: 0, dismissed: 0 });

/** Titles and tags of the active plaintext learning / theme / project notes: what the user is working on right now. */
export function interestsFromNotes(db: Database, max = 40): string[] {
  const out = new Set<string>();
  const closed = new Set(["done", "closed", "dropped", "paused", "archived"]);
  for (const type of ["learning", "theme", "project"]) {
    for (const n of runQuery(db, { filters: [{ field: "type", op: "=", value: type }], orderBy: "-updated", limit: 50 })) {
      if (isEncryptedPath(n.path) || closed.has(n.status)) continue;
      out.add(n.title);
      for (const t of n.tags) out.add(t);
    }
  }
  return [...out].slice(0, max);
}

export function buildCurateInput(cfg: KbConfig, candidates: ArticleItem[], opts: { date: string; db?: Database | null; history?: ArticleHistory; prefs?: ArticlePrefs }): CurateInput {
  const prefs = opts.prefs ?? loadArticlePrefs(cfg);
  const history = opts.history ?? buildHistory(listArticleDays(cfg));
  const interests = [...new Set([...prefs.interests, ...(opts.db ? interestsFromNotes(opts.db) : [])])];
  return {
    date: opts.date, max: prefs.max_per_day, explore_min: prefs.explore_min, interests, avoid: prefs.avoid, history,
    items: candidates.map((c) => ({ id: c.id, title: c.title, feed: c.feed, published: c.published, summary: clip(c.summary, SUMMARY_CHARS) })),
  };
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Check the agent's answer against the input. Structural problems (not an object, unknown ids, no `picks`) throw; a
 * short `general` quota or picks beyond `max` are reported as warnings and the list is trimmed (general picks kept first).
 */
export function parseCurateOutput(raw: unknown, input: Pick<CurateInput, "max" | "explore_min" | "items">): { picks: CuratePick[]; warnings: string[] } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { picks?: unknown }).picks)) throw new Error("curate output: expected { picks: [...] }");
  const ids = new Set(input.items.map((i) => i.id));
  const seen = new Set<string>();
  const picks: CuratePick[] = [];
  const warnings: string[] = [];
  for (const [i, p] of ((raw as { picks: unknown[] }).picks).entries()) {
    if (!p || typeof p !== "object") throw new Error(`curate output: picks[${i}] is not an object`);
    const o = p as Record<string, unknown>;
    const id = String(o.id ?? "");
    if (!ids.has(id)) throw new Error(`curate output: picks[${i}] has unknown id ${JSON.stringify(id)}`);
    if (seen.has(id)) { warnings.push(`duplicate pick ${id} dropped`); continue; }
    seen.add(id);
    const basis: ArticleBasis = o.basis === "general" ? "general" : "fit";
    if (o.basis !== "general" && o.basis !== "fit") warnings.push(`pick ${id}: basis ${JSON.stringify(o.basis)} read as fit`);
    const reason = clip(String(o.reason ?? "").replace(/\s+/g, " ").trim(), REASON_CHARS);
    if (!reason) warnings.push(`pick ${id}: no reason`);
    const topics = Array.isArray(o.topics) ? o.topics.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => clip(t.trim(), 20)).slice(0, TOPICS_MAX) : [];
    picks.push({ id, basis, reason, topics });
  }
  const general = picks.filter((p) => p.basis === "general").length;
  if (general < Math.min(input.explore_min, picks.length)) warnings.push(`only ${general} general pick(s), ${input.explore_min} wanted`);
  if (picks.length > input.max) {
    warnings.push(`${picks.length} picks, cap ${input.max}: extra fit picks dropped`);
    const kept: CuratePick[] = [];
    for (const p of picks) if (p.basis === "general" && kept.length < input.max) kept.push(p);
    for (const p of picks) if (p.basis === "fit" && kept.length < input.max) kept.push(p);
    picks.splice(0, picks.length, ...kept.sort((a, b) => picks.indexOf(a) - picks.indexOf(b)));
  }
  return { picks, warnings };
}

/**
 * Write the day's file from the candidates and the (validated) picks, merging into a file that already exists for the
 * date (a second run on the same day keeps the earlier items and their reactions), and mark the feed files processed.
 */
export function applyCurateOutput(cfg: KbConfig, o: { date: string; candidates: ArticleItem[]; bronzeIds: string[]; picks: CuratePick[]; warnings?: string[]; now?: Date }): { day: ArticleDay; path: string } {
  const byId = new Map(o.picks.map((p) => [p.id, p]));
  const fresh = o.candidates.map((c) => {
    const p = byId.get(c.id);
    return p ? { ...c, picked: true, basis: p.basis, reason: p.reason, topics: p.topics } : { ...c, picked: false };
  });
  const prev = readArticleDay(cfg, o.date);
  const items = prev ? [...prev.items, ...fresh.filter((f) => !prev.items.some((x) => x.id === f.id))] : fresh;
  const warnings = [...(prev?.warnings ?? []), ...(o.warnings ?? [])];
  const day: ArticleDay = { date: o.date, curated_at: (o.now ?? new Date()).toISOString(), feeds: [...new Set(items.map((i) => i.feed))].sort(), items, ...(warnings.length ? { warnings } : {}) };
  const path = writeArticleDay(cfg, day);
  for (const id of o.bronzeIds) markProcessed(cfg, id, [path]);
  return { day, path };
}

export interface CurateResult {
  /** Nothing new in the feeds: no file written, no agent run. */
  skipped?: true;
  /** `--dry`: the input only. */
  input?: CurateInput;
  day?: ArticleDay;
  path?: string;
  warnings: string[];
  candidates: number;
}

/**
 * The whole run: candidates → input file → agent (`run(inputPath, outputPath)`, usually run-agent.sh with the `curate`
 * skill) → output file → day file. The agent must write the output file; anything it prints is ignored.
 */
export async function curateArticles(cfg: KbConfig, o: { date?: string; db?: Database | null; dry?: boolean; now?: Date; run: (inputPath: string, outputPath: string) => Promise<void> }): Promise<CurateResult> {
  const now = o.now ?? new Date();
  const date = o.date ?? localDate(now.toISOString());
  const { items, bronzeIds } = collectCandidates(cfg, knownArticleIds(cfg, DEDUPE_DAYS, now));
  if (!items.length) {
    // feeds with nothing new are still done with
    for (const id of bronzeIds) markProcessed(cfg, id, ["-"]);
    return { skipped: true, warnings: [], candidates: 0 };
  }
  const input = buildCurateInput(cfg, items, { date, db: o.db });
  if (o.dry) return { input, warnings: [], candidates: items.length };
  const inPath = join(cfg.root, CURATE_INPUT_REL), outPath = join(cfg.root, CURATE_OUTPUT_REL);
  mkdirSync(join(inPath, ".."), { recursive: true });
  writeFileSync(inPath, JSON.stringify(input, null, 1));
  if (existsSync(outPath)) unlinkSync(outPath);
  await o.run(inPath, outPath);
  if (!existsSync(outPath)) throw new Error(`curate: the agent did not write ${CURATE_OUTPUT_REL}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(outPath, "utf8")); } catch (e) { throw new Error(`curate: ${CURATE_OUTPUT_REL} is not JSON (${(e as Error).message})`); }
  const { picks, warnings } = parseCurateOutput(raw, input);
  const { day, path } = applyCurateOutput(cfg, { date, candidates: items, bronzeIds, picks, warnings, now });
  return { day, path, warnings, candidates: items.length };
}

/** Record a reaction on one item of one day. `opened` only stamps `opened_at` (a later save / dismiss still applies). */
export function reactToArticle(cfg: KbConfig, o: { date: string; id: string; reaction: ArticleReaction; now?: Date }): { path: string; item: ArticleItem } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error(`bad date ${o.date}`);
  const day = readArticleDay(cfg, o.date);
  const item = day?.items.find((i) => i.id === o.id);
  if (!day || !item) throw new Error(`article ${o.id} not found in ${articlePath(o.date)}`);
  const at = (o.now ?? new Date()).toISOString();
  if (o.reaction === "opened") item.opened_at ??= at;
  else if (o.reaction === "done" && item.reaction !== "later") throw new Error(`article ${o.id}: done is only for an article queued with later`);
  else {
    if (o.reaction === "later") item.later_at ??= at;
    item.reaction = o.reaction;
    item.reacted_at = at;
  }
  return { path: writeArticleDay(cfg, day), item };
}

const GOLD_MARK: Record<ArticleState, string> = { later: "☆ ", saved: "◎ ", dismissed: "× ", done: "✓ " };
const mdDate = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}`; };

/** Gold 309: the read-later queue (every day), then the last two weeks of picks with how each fared. */
export function renderArticlesGold(cfg: KbConfig, days = 14): string {
  const lines = ["# 記事", "", "RSS の新着から `curate` ジョブが毎朝選んだ記事。全候補と反応は `900_system/articles/YYYY-MM-DD.json`、表示と反応の記録は WebUI の「記事」タブ。☆ 後で読む · ◎ 取り込んだ · ✓ 読んだ · ○ 開いた · × 興味なし", ""];
  const list = listArticleDays(cfg, { limit: days });
  if (!list.length) return [...lines, "（まだありません。`kb articles curate` が作ります）"].join("\n");
  const later = listLaterArticles(cfg);
  if (later.length) {
    lines.push(`## 後で読む（${later.length} 件）`, "", "期限で消えない。読んだら WebUI で「取り込む」「読んだ」「興味なし」のどれかを押す。", "");
    for (const { item: it } of later) lines.push(`- [${it.title}](${it.url}) — ${it.feed} — ${mdDate(it.later_at ?? "")} から${it.opened_at ? "・開いた" : ""}${it.reason ? ` — ${it.reason}` : ""}`);
    lines.push("");
  }
  for (const d of list) {
    const s = articleStats(d);
    lines.push(`## ${d.date}（${s.picked} 件 / 候補 ${s.candidates} 件）`, "");
    for (const it of d.items.filter((i) => i.picked)) {
      const mark = it.reaction ? GOLD_MARK[it.reaction] : it.opened_at ? "○ " : "";
      lines.push(`- ${mark}[${it.title}](${it.url}) — ${it.feed}${it.basis === "general" ? "・一般" : ""}${it.reason ? ` — ${it.reason}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
