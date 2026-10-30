import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { KbConfig } from "./config";
import { createNote, findDuplicates } from "./create";
import { bronzeDir, markProcessed, readMeta } from "./bronze";
import { parseCsvLine } from "./portfolio";
import { csvObjects } from "./collect/csv";
import { parseNote, stringifyNote } from "./frontmatter";
import type { QueryResult } from "./query";
import type { SchemaRegistry } from "./schema";
import { decodeText } from "./text";

/**
 * 204_books as a reading record, not a catalogue. A bulk-imported book (Kobo library export) carries
 * `imported: true`, its purchase date in `purchased_at` and this fixed summary until the owner rates it and writes a
 * one-line summary of their own (the weekly `review` lists five such books at a time).
 */
export const IMPORTED_SUMMARY = "Kobo ライブラリから取り込み";
/** Same role for a book first seen in a StoryGraph library export (`kb book import` on that CSV). */
export const STORYGRAPH_SUMMARY = "StoryGraph から取り込み";

type Fm = Record<string, unknown>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const dateOf = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v.slice(0, 10) : "");

/** The date a read book is filed under: `finished_at`, else `purchased_at` (an imported book only knows when it was bought). */
export function bookDate(fm: Fm): string {
  return dateOf(fm.finished_at) || dateOf(fm.purchased_at);
}
/** Year for the 304_books/<year>.md grouping; "unknown" when neither date is set. */
export function bookYear(fm: Fm): string {
  return bookDate(fm).slice(0, 4) || "unknown";
}
export const isImported = (fm: Fm) => fm.imported === true;
const hasRating = (fm: Fm) => Number(fm.rating ?? 0) > 0;

/** Imported, read, never rated: the books the weekly review hands back to the owner, oldest purchase first. */
export function unratedImported(books: QueryResult[]): QueryResult[] {
  return books
    .filter((b) => b.status === "read" && isImported(b.fm) && !hasRating(b.fm))
    .sort((a, b) => bookDate(a.fm).localeCompare(bookDate(b.fm)) || a.title.localeCompare(b.title, "ja"));
}

/**
 * The one-line summary the first Kobo bulk import (2026-10) wrote into every note:
 * 「<著者>の<ジャンル>（<出版社>）。楽天Kobo で <日付> に購入、読了（ライブラリ一括取り込み。<日付> に本人が全て読了と確認）」
 * (the genre word is missing on a few). Returns the fields to move into frontmatter, or null for any other summary.
 */
export function parseImportedSummary(summary: string): { publisher: string; purchased_at: string } | null {
  const m = /^.*（([^（）]+)）。楽天Kobo で (\d{4}-\d{2}-\d{2}) に購入、読了（ライブラリ一括取り込み。\d{4}-\d{2}-\d{2} に本人が全て読了と確認）$/.exec(summary.trim());
  return m ? { publisher: m[1], purchased_at: m[2] } : null;
}

/** One row of the 楽天Kobo library export (`kobo*.csv`: productId,isbn,adultType,title,authorName,companyName,imageUrl,detailUrl,addDate). */
export interface KoboRow { title: string; author: string; publisher: string; isbn: string; url: string; addedAt: string }
const ISBN_RE = /^97[89]\d{10}$/; // the `isbn` column is often a Kobo product code; keep only real ISBN-13s

export function parseKoboCsv(text: string): KoboRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = parseCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const [iTitle, iAuthor, iPub, iIsbn, iUrl, iDate] = ["title", "authorName", "companyName", "isbn", "detailUrl", "addDate"].map(col);
  if (iTitle < 0 || iDate < 0) throw new Error(`not a Kobo library export (header: ${lines[0].slice(0, 80)})`);
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return lines.slice(1).map(parseCsvLine).filter((r) => cell(r, iTitle)).map((r) => ({
    title: cell(r, iTitle), author: cell(r, iAuthor), publisher: cell(r, iPub),
    isbn: ISBN_RE.test(cell(r, iIsbn)) ? cell(r, iIsbn) : "", url: cell(r, iUrl), addedAt: dateOf(cell(r, iDate)),
  }));
}

export interface ImportKoboResult { bronzeId: string; created: { path: string; title: string }[]; skipped: { title: string; path: string }[] }

/**
 * `kb book import <bronze-id> [--status read]`: one `book` note per row of a Kobo library export in Bronze, with
 * `imported: true`, `purchased_at`, `publisher`, `platform: kobo` and the fixed summary. Rows whose title or ISBN already
 * has a note are skipped (re-exporting the whole library is the normal case), so the command is safe to repeat.
 * Genre / subgenre stay empty for the ingest skill to fill. The Bronze item is marked processed with the notes created.
 */
export function importKoboLibrary(cfg: KbConfig, reg: SchemaRegistry, db: Database, bronzeId: string, opts: { status?: string } = {}): ImportKoboResult {
  const meta = readMeta(cfg, bronzeId);
  const file = meta?.files.find((f) => /\.csv$/i.test(f));
  if (!meta || !file) throw new Error(`${bronzeId} is not a CSV in Bronze`);
  const rows = parseKoboCsv(decodeText(readFileSync(join(bronzeDir(cfg, bronzeId), file))));
  const status = opts.status ?? "want";
  const seen = new Set<string>();
  const out: ImportKoboResult = { bronzeId, created: [], skipped: [] };
  for (const r of rows) {
    const key = r.isbn || r.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const dup = findDuplicates(db, "book", r.title, r.isbn ? { isbn: r.isbn } : undefined)[0];
    if (dup) { out.skipped.push({ title: r.title, path: dup.path }); continue; }
    const set: Fm = {
      status, author: r.author, publisher: r.publisher, platform: "kobo", purchased_at: r.addedAt, imported: true,
      summary: IMPORTED_SUMMARY, sources: [bronzeId], ...(r.isbn ? { isbn: r.isbn } : {}),
    };
    let rel: string;
    try { rel = createNote(cfg, reg, null, { type: "book", title: r.title, set }); }
    catch (e) {
      if (e instanceof Error && e.message.startsWith("exists:")) { out.skipped.push({ title: r.title, path: e.message.slice("exists: ".length) }); continue; }
      throw e;
    }
    const abs = join(cfg.root, rel);
    if (r.url && existsSync(abs)) {
      const text = readFileSync(abs, "utf8");
      const h = "## 概要（ネタバレなし）\n";
      if (text.includes(h)) writeFileSync(abs, text.replace(h, `${h}\n- 商品ページ: ${r.url}\n`));
    }
    out.created.push({ path: rel, title: r.title });
  }
  if (out.created.length) markProcessed(cfg, bronzeId, out.created.map((c) => c.path));
  return out;
}

// --- StoryGraph library export (Manage Account → Export StoryGraph Library; the download is <hash>.csv) ---

/**
 * One row of the StoryGraph export, reduced to what the reading record keeps. Header:
 * Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,…,
 * Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?
 * Dates are `YYYY/MM/DD`; `Dates Read` is `start-end` per read, several reads joined by ", " (either side may be empty).
 */
export interface StoryGraphRow {
  title: string;
  author: string;
  /** As exported: ISBN-13, ISBN-10 or a retailer UID (13 digits that are not an ISBN). Empty when unknown. */
  isbn: string;
  format: string;
  status: "want" | "reading" | "read" | "dnf";
  /** The raw Read Status, for the report (`paused` also maps to reading). */
  readStatus: string;
  addedAt: string;
  startedAt: string;
  finishedAt: string;
  readCount: number;
  /** 1–5 (StoryGraph's quarter stars rounded), 0 = unrated. */
  rating: number;
  review: string;
  tags: string[];
}

export const STORYGRAPH_HEADER = "Title,Authors,Contributors,ISBN/UID,Format,Read Status";
export const isStoryGraphCsv = (text: string) => text.replace(/^\uFEFF/, "").startsWith(STORYGRAPH_HEADER);
export const isKoboCsv = (text: string) => /^\uFEFF?"?productId"?,/.test(text);

const SG_STATUS: Record<string, StoryGraphRow["status"]> = { "to-read": "want", "currently-reading": "reading", paused: "reading", read: "read", "did-not-finish": "dnf" };
const sgDate = (v: string) => { const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(v.trim()); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };

/** The last read's start / end from `Dates Read` ("2026/09/27-2026/10/30, 2027/01/02-"), falling back to `Last Date Read`. */
export function parseDatesRead(datesRead: string, lastDateRead: string): { startedAt: string; finishedAt: string } {
  const reads = datesRead.split(",").map((r) => r.trim()).filter(Boolean);
  const last = reads[reads.length - 1];
  const [start = "", end = ""] = last ? last.split("-").map((d) => sgDate(d)) : [];
  return { startedAt: start, finishedAt: end || sgDate(lastDateRead) };
}

export function parseStoryGraphCsv(text: string): StoryGraphRow[] {
  if (!isStoryGraphCsv(text)) throw new Error(`not a StoryGraph library export (header: ${text.slice(0, 60).replace(/\s+/g, " ")})`);
  return csvObjects(text).filter((r) => r.Title).map((r) => {
    const { startedAt, finishedAt } = parseDatesRead(r["Dates Read"] ?? "", r["Last Date Read"] ?? "");
    const stars = Number(r["Star Rating"] ?? "");
    return {
      title: r.Title!, author: r.Authors ?? "", isbn: (r["ISBN/UID"] ?? "").replace(/[^0-9Xx]/g, ""), format: r.Format ?? "",
      status: SG_STATUS[r["Read Status"] ?? ""] ?? "want", readStatus: r["Read Status"] ?? "",
      addedAt: sgDate(r["Date Added"] ?? ""), startedAt, finishedAt,
      readCount: Number(r["Read Count"] ?? 0) || 0,
      rating: stars > 0 ? Math.min(5, Math.max(1, Math.round(stars))) : 0,
      review: (r.Review ?? "").trim(),
      tags: (r.Tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    };
  });
}

/** ISBN-10 → ISBN-13 so an export row matches a note that recorded the other form. Anything else is returned as-is. */
export function isbn13(isbn: string): string {
  const s = isbn.replace(/[^0-9Xx]/g, "");
  if (s.length !== 10) return s;
  const core = `978${s.slice(0, 9)}`;
  const sum = [...core].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** Shelf platform from the export's Format (digital stays empty: the export does not say which store). */
const SG_PLATFORM: Record<string, string> = { audio: "audio", paperback: "紙", hardcover: "紙" };

export interface ImportStoryGraphResult {
  bronzeId: string;
  created: { path: string; title: string }[];
  updated: { path: string; title: string; changes: string[] }[];
  unchanged: { path: string; title: string }[];
  /** Rows whose status would move a read book back to want / reading: left alone, listed for the owner. */
  kept: { path: string; title: string; readStatus: string }[];
}

/**
 * `kb book import <bronze-id>` on a StoryGraph export: the reading record is upserted into 204_books.
 * Matching is by ISBN (either form) then normalised title. An existing note gets status / started_at / finished_at /
 * rating from the export and, when its 感想 section is still empty, the review; its summary and body are otherwise
 * untouched. A `read` note never goes back to want / reading (a re-added or re-read book is reported instead).
 * A new note is created like the Kobo import (`imported: true`, fixed summary) with the same fields. Safe to repeat:
 * the whole library export is the normal input.
 */
export function importStoryGraphLibrary(cfg: KbConfig, reg: SchemaRegistry, db: Database, bronzeId: string): ImportStoryGraphResult {
  const meta = readMeta(cfg, bronzeId);
  const file = meta?.files.find((f) => /\.csv$/i.test(f));
  if (!meta || !file) throw new Error(`${bronzeId} is not a CSV in Bronze`);
  const rows = parseStoryGraphCsv(decodeText(readFileSync(join(bronzeDir(cfg, bronzeId), file))));
  const out: ImportStoryGraphResult = { bronzeId, created: [], updated: [], unchanged: [], kept: [] };
  const notes = (db.query("SELECT path, title, fm FROM notes WHERE type='book'").all() as { path: string; title: string; fm: string }[])
    .map((r) => ({ path: r.path, title: r.title, fm: JSON.parse(r.fm) as Fm }));
  const norm = (s: string) => s.toLowerCase().replace(/[\s　・:：\-—–]/g, "");
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.isbn ? isbn13(r.isbn) : norm(r.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = (r.isbn && notes.find((n) => n.fm.isbn && isbn13(String(n.fm.isbn)) === isbn13(r.isbn))) || notes.find((n) => norm(n.title) === norm(r.title));
    const fields: Fm = { status: r.status };
    if (r.startedAt) fields.started_at = r.startedAt;
    if (r.finishedAt) fields.finished_at = r.finishedAt;
    if (r.rating) fields.rating = r.rating;
    if (hit) {
      const abs = join(cfg.root, hit.path);
      const { fm, body } = parseNote(readFileSync(abs, "utf8"));
      if (fm.status === "read" && r.status !== "read") { out.kept.push({ path: hit.path, title: hit.title, readStatus: r.readStatus }); continue; }
      const changes: string[] = [];
      for (const [k, v] of Object.entries(fields)) if (String(fm[k] ?? "") !== String(v)) { fm[k] = v; changes.push(`${k}=${v}`); }
      if (r.isbn && !fm.isbn) { fm.isbn = r.isbn; changes.push("isbn"); }
      let newBody = body;
      if (r.review && !hasSectionText(body, "感想（ネタバレなし）")) { newBody = fillSection(body, "感想（ネタバレなし）", r.review); changes.push("review"); }
      if (!changes.length) { out.unchanged.push({ path: hit.path, title: hit.title }); continue; }
      fm.updated = today();
      writeFileSync(abs, stringifyNote(fm, newBody));
      out.updated.push({ path: hit.path, title: hit.title, changes });
      continue;
    }
    const set: Fm = {
      ...fields, author: r.author, imported: true, summary: STORYGRAPH_SUMMARY, sources: [bronzeId],
      ...(r.isbn ? { isbn: r.isbn } : {}), ...(SG_PLATFORM[r.format] ? { platform: SG_PLATFORM[r.format] } : {}),
    };
    let rel: string;
    try { rel = createNote(cfg, reg, null, { type: "book", title: r.title, set }); }
    catch (e) {
      if (e instanceof Error && e.message.startsWith("exists:")) { out.unchanged.push({ title: r.title, path: e.message.slice("exists: ".length) }); continue; }
      throw e;
    }
    if (r.review) { const abs = join(cfg.root, rel); const { fm, body } = parseNote(readFileSync(abs, "utf8")); writeFileSync(abs, stringifyNote(fm, fillSection(body, "感想（ネタバレなし）", r.review))); }
    out.created.push({ path: rel, title: r.title });
    notes.push({ path: rel, title: r.title, fm: set });
  }
  const touched = [...out.created, ...out.updated].map((c) => c.path);
  if (touched.length) markProcessed(cfg, bronzeId, touched);
  return out;
}

const today = () => new Date().toLocaleDateString("sv-SE");
function sectionRange(body: string, heading: string): { start: number; end: number } | null {
  const h = `## ${heading}`;
  const idx = body.indexOf(h);
  if (idx === -1) return null;
  const after = body.indexOf("\n## ", idx + h.length);
  return { start: idx + h.length, end: after === -1 ? body.length : after };
}
/** True when the section has any text besides blank lines and a quote-callout stub. */
function hasSectionText(body: string, heading: string): boolean {
  const r = sectionRange(body, heading);
  return !!r && body.slice(r.start, r.end).split("\n").some((l) => l.trim() && !/^>\s*(\[!spoiler\]-)?\s*$/.test(l.trim()));
}
/** Put `text` into an (empty) section, or append the section when the note has none. */
function fillSection(body: string, heading: string, text: string): string {
  const r = sectionRange(body, heading);
  if (!r) return `${body.trimEnd()}\n\n## ${heading}\n\n${text}\n`;
  return `${body.slice(0, r.start)}\n\n${text}\n${r.end < body.length ? "\n" + body.slice(r.end + 1) : ""}`;
}
