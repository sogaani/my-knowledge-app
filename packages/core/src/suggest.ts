/**
 * Suggestions (the `recommend` skill's output) live in Silver as `recommendation` notes (208_reviews): hand-written by
 * the skill, with the user's reactions (read / dismissed) written into the checklist lines by the WebUI. Gold's
 * 307_suggestions.md is derived from them by `kb build` and is never edited.
 *
 * A line: `- [ ] **Title** — meta / meta / meta — reason <!-- id: book-slug[, reaction: read] -->` under `## 本`,
 * `## 映画・ドラマ` or `## 記事` (articles: `- [ ] [Title](URL) — reason <!-- id: article-slug -->`). The meta fields are
 * what a note made from the suggestion needs: `author / genre / subgenre` for a book, `kind / genre` for media.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { createNote, DuplicateError } from "./create";
import { parseNote, stringifyNote } from "./frontmatter";
import { readNote, walkNotes, type Note } from "./notes";
import { runQuery, type QueryResult } from "./query";
import type { SchemaRegistry } from "./schema";

export const RECOMMENDATION_TYPE = "recommendation";
/** `sources` entry of a note made from a suggestion: `suggestion:<id>` (the id of the checklist line). */
export const SUGGESTION_SOURCE_PREFIX = "suggestion:";

export type SuggestionKind = "book" | "media" | "article";
export type Reaction = "read" | "dismissed";

export interface SuggestionItem {
  id: string;
  /** Heading the line sits under (`本`, `映画・ドラマ`, `記事`). */
  section: string;
  kind: SuggestionKind;
  title: string;
  /** The ` / `-separated fields between the title and the reason. */
  meta: string[];
  reason: string;
  reaction?: Reaction | string;
  url?: string;
  /** The line without the checkbox and the marker (what the WebUI shows). */
  line: string;
}

const ITEM_RE = /^- \[[ x]\]\s*(.*?)\s*<!--\s*id:\s*([^,\s]+)(?:,\s*reaction:\s*(\w+))?\s*-->\s*$/;
const SEP = " — ";

export function kindOfSection(section: string): SuggestionKind {
  return section.includes("本") ? "book" : section.includes("映画") || section.includes("ドラマ") ? "media" : "article";
}

/** Items of a recommendation note body (or a whole file). */
export function parseSuggestions(markdown: string): SuggestionItem[] {
  const items: SuggestionItem[] = [];
  let section = "";
  for (const raw of markdown.split("\n")) {
    const h = /^##\s+(.+)/.exec(raw);
    if (h) { section = h[1]!.trim(); continue; }
    const m = ITEM_RE.exec(raw);
    if (!m) continue;
    const body = m[1]!;
    const parts = body.split(SEP);
    const head = parts[0] ?? body;
    const title = /\*\*(.+?)\*\*/.exec(head)?.[1] ?? /\[(.+?)\]\(/.exec(head)?.[1] ?? head.trim();
    const url = /\((https?:[^)]+)\)/.exec(head)?.[1];
    const kind = kindOfSection(section);
    const meta = kind !== "article" && parts.length >= 3 ? parts[1]!.split("/").map((s) => s.trim()).filter(Boolean) : [];
    const reason = (kind !== "article" && parts.length >= 3 ? parts.slice(2) : parts.slice(1)).join(SEP).trim();
    items.push({ id: m[2]!, section, kind, title, meta, reason, reaction: m[3], url, line: body.replace(/\*\*/g, "") });
  }
  return items;
}

/** The recommendation note the WebUI shows and reactions go to: the open one with the latest `date` (then `updated`). */
export function currentRecommendation(db: Database): QueryResult | null {
  const open = runQuery(db, { filters: [{ field: "type", op: "=", value: RECOMMENDATION_TYPE }, { field: "status", op: "=", value: "open" }], orderBy: "-date", limit: 50 });
  const sorted = open.sort((a, b) => String(b.fm.date ?? "").localeCompare(String(a.fm.date ?? "")) || b.updated.localeCompare(a.updated));
  return sorted[0] ?? null;
}

/** Every suggestion id across all recommendation notes (archived too), for `sources: [suggestion:<id>]` validation. */
export function suggestionIds(cfg: KbConfig, notes?: Iterable<Note>): Set<string> {
  const ids = new Set<string>();
  for (const n of notes ?? walkNotes(cfg, { dirs: [cfg.silver], includeArchive: true })) {
    if (n.type !== RECOMMENDATION_TYPE) continue;
    for (const it of parseSuggestions(n.body)) ids.add(it.id);
  }
  return ids;
}

export interface ReactResult {
  /** The recommendation note that was marked. */
  path: string;
  item: SuggestionItem;
  /** Silver note created for a `read` reaction on a book / media suggestion (null for articles, dismissals, duplicates). */
  created: string | null;
  /** An existing note with the same title, when nothing was created because of it. */
  existing?: string;
}

const MEDIA_KINDS: Record<string, string> = { movie: "movie", drama: "drama", anime: "anime", documentary: "documentary", video: "video", 映画: "movie", ドラマ: "drama", アニメ: "anime", ドキュメンタリー: "documentary", 動画: "video" };

/**
 * Record a reaction on the current recommendation note (checkbox + `reaction:` in the marker) and, for `read` on a
 * book / media item, create the Silver note with what the line says: author / genre / subgenre (book), kind (media),
 * the reason as summary, `sources: [suggestion:<id>]` and `related` back to the recommendation note.
 */
export function reactToSuggestion(cfg: KbConfig, reg: SchemaRegistry, db: Database, o: { id: string; reaction: Reaction }): ReactResult {
  const current = currentRecommendation(db);
  if (!current) throw new Error("no open recommendation note");
  const abs = join(cfg.root, current.path);
  const note = readNote(cfg, abs);
  const item = note ? parseSuggestions(note.body).find((it) => it.id === o.id) : undefined;
  if (!note || !item) throw new Error(`suggestion ${o.id} not found in ${current.path}`);
  const marker = new RegExp(`<!--\\s*id:\\s*${escapeRe(o.id)}[^>]*-->`);
  const body = note.body.split("\n").map((line) => (marker.test(line) && ITEM_RE.test(line)
    ? line.replace(/^- \[[ x]\]/, "- [x]").replace(marker, `<!-- id: ${o.id}, reaction: ${o.reaction} -->`)
    : line)).join("\n");
  const fm = { ...note.fm, updated: today() };
  writeFileSync(abs, stringifyNote(fm, body));
  let created: string | null = null;
  let existing: string | undefined;
  if (o.reaction === "read" && item.kind !== "article") {
    const set = noteFieldsFor(reg, item, current.path);
    try {
      created = createNote(cfg, reg, db, { type: item.kind, title: item.title, set });
    } catch (e) {
      if (!(e instanceof DuplicateError)) throw e;
      existing = e.matches[0]?.path;
    }
  }
  return { path: current.path, item, created, existing };
}

/** Frontmatter for a book / media note made from a suggestion line. Exported for tests and for the skill's own use. */
export function noteFieldsFor(reg: SchemaRegistry, item: SuggestionItem, recommendationPath: string): Record<string, unknown> {
  const def = reg.get(item.kind);
  const folder = def?.folder ?? "";
  const related = relLink(`${folder}/x.md`, recommendationPath);
  const set: Record<string, unknown> = { status: "want", summary: item.reason, sources: [`${SUGGESTION_SOURCE_PREFIX}${item.id}`], related: [related] };
  const [a, b, c] = item.meta;
  if (item.kind === "book") {
    if (a) set.author = a;
    if (b) set.genre = b;
    const allowed = (def?.schema as { properties?: { subgenre?: { enum?: string[] } } } | undefined)?.properties?.subgenre?.enum;
    if (c && (!allowed || allowed.includes(c))) set.subgenre = c;
  } else if (item.kind === "media") {
    const kind = a ? MEDIA_KINDS[a] : undefined;
    if (kind) set.kind = kind;
  }
  return set;
}

/** Path of `to` relative to the folder of note `from` (both repo-relative), the way `related:` entries are written. */
export function relLink(from: string, to: string): string {
  const r = posix.relative(posix.dirname(from), to);
  return r.startsWith(".") ? r : `./${r}`;
}

/** Per-section counts of a recommendation note: how many items are read / dismissed / still waiting. */
export function suggestionCounts(items: SuggestionItem[]): { section: string; total: number; read: number; dismissed: number; open: number }[] {
  const out = new Map<string, { section: string; total: number; read: number; dismissed: number; open: number }>();
  for (const it of items) {
    const row = out.get(it.section) ?? { section: it.section, total: 0, read: 0, dismissed: 0, open: 0 };
    row.total++;
    if (it.reaction === "read") row.read++;
    else if (it.reaction === "dismissed") row.dismissed++;
    else row.open++;
    out.set(it.section, row);
  }
  return [...out.values()];
}

/** Body of a recommendation note on disk (the file may have been edited after the index was built). */
export function readSuggestionBody(cfg: KbConfig, rel: string): string {
  const abs = join(cfg.root, rel);
  return existsSync(abs) ? parseNote(readFileSync(abs, "utf8")).body : "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
