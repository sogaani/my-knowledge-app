import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { KbConfig } from "./config";
import { createNote, findDuplicates } from "./create";
import { bronzeDir, markProcessed, readMeta } from "./bronze";
import { parseCsvLine } from "./portfolio";
import type { QueryResult } from "./query";
import type { SchemaRegistry } from "./schema";
import { decodeText } from "./text";

/**
 * 204_books as a reading record, not a catalogue. A bulk-imported book (Kobo library export) carries
 * `imported: true`, its purchase date in `purchased_at` and this fixed summary until the owner rates it and writes a
 * one-line summary of their own (the weekly `review` lists five such books at a time).
 */
export const IMPORTED_SUMMARY = "Kobo ライブラリから取り込み";

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
