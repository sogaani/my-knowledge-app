/**
 * Hybrid search over Silver notes: LanceDB vector (Ollama dense) + LanceDB BM25 (Lindera tokens),
 * fused with Reciprocal Rank Fusion, cut at a cosine-distance threshold, grouped per note (with a confidence),
 * joined with SQLite for frontmatter filters.
 * Falls back to the SQLite trigram search when the vector store or Ollama is unavailable.
 */
import type { Database } from "bun:sqlite";
import { SILVER_PREFIX, type KbConfig } from "./config";
import type { NoteRow } from "./db";
import { queryTerms, runQuery, type Filter } from "./query";
import { stripSpoilers } from "./chunk";
import type { Embedder } from "./embed";
import { VectorStore, sqlStr, type ChunkRow } from "./vector";

export type SearchMode = "hybrid" | "vector" | "keyword";
export interface SearchOpts {
  mode?: SearchMode;
  filters?: Filter[];
  includeArchive?: boolean;
  /** notes to return (default 10) */
  limit?: number;
  /** chunk candidates per retriever before fusion (default 50) */
  candidates?: number;
  /** show spoiler chunk text in snippets (default false) */
  spoilers?: boolean;
}
export interface SearchMatch {
  path: string; heading: string; snippet: string; spoiler: boolean; via: ("vector" | "keyword")[];
  /** cosine distance of the chunk to the query (vector retriever; 0 = identical) */
  vectorDistance?: number;
  /** BM25 score (keyword retriever) */
  bm25?: number;
}
/** `high`: a lexical hit or a close vector neighbour backs the note. `low`: only a loose semantic resemblance (or a partial term match). */
export type Confidence = "high" | "low";
export interface SearchHit {
  path: string; type: string; title: string; status: string; summary: string; tags: string[]; updated: string; archived: boolean;
  score: number; confidence: Confidence; matches: SearchMatch[];
}
export interface SearchResponse { hits: SearchHit[]; mode: SearchMode; degraded?: string }

const RRF_K = 60;
/**
 * bge-m3 cosine distance above which a chunk that only the vector retriever found, and that contains none of the
 * query terms, is dropped (so an off-topic query returns nothing instead of `limit` neighbours). Measured on the
 * real index — see docs/search.md: on-topic chunks sit at 0.38–0.55, the best neighbour of an off-topic query at 0.59+.
 */
export const VECTOR_CUTOFF = 0.55;
/** Distance at or below which a vector hit alone (on a non-thin chunk) counts as strong evidence for a note. */
export const VECTOR_STRONG = 0.5;
/**
 * Weight of a `thin` chunk (a note with nothing but its header) that only the vector retriever found: similarity on a
 * title + summary alone is weak evidence, so such notes sit below ones with content. A lexical hit keeps full weight.
 */
export const THIN_WEIGHT = 0.5;
/** Fields the Lance table can filter on directly; anything else is checked against SQLite frontmatter. */
const LANCE_FIELDS = new Set(["type", "status", "domain"]);

export async function search(cfg: KbConfig, db: Database, query: string, opts: SearchOpts = {}, deps: { store?: VectorStore; embedder?: Embedder } = {}): Promise<SearchResponse> {
  const q = query.trim();
  const limit = opts.limit ?? 10;
  const filters = opts.filters ?? [];
  const fallback = (reason: string): SearchResponse => ({ hits: keywordSearch(db, q, filters, opts), mode: "keyword", degraded: reason });
  if (!q) return { hits: keywordSearch(db, "", filters, opts), mode: "keyword" };

  let store = deps.store;
  try { store ??= await VectorStore.open(cfg); } catch (e) { return fallback(`lance: ${(e as Error).message}`); }
  if (!store.ready) return fallback("no vector index (run: kb embed)");

  let mode: SearchMode = opts.mode ?? "hybrid";
  let degraded: string | undefined;
  let vector: number[] | null = null;
  if (mode !== "keyword") {
    const emb = deps.embedder;
    const ping = emb ? await emb.ping() : { ok: false as const, reason: "no embedder" };
    if (!ping.ok || !emb) {
      if (mode === "vector") return fallback(ping.ok ? "no embedder" : ping.reason);
      degraded = ping.ok ? "no embedder" : ping.reason;
      mode = "keyword";
    } else {
      vector = (await emb.embed([q], "query"))[0];
    }
  }

  const where = buildWhere(filters, !!opts.includeArchive);
  const k = opts.candidates ?? 50;
  const [vecRows, ftsRows] = await Promise.all([
    vector ? store.vectorSearch(vector, { where, limit: k }) : Promise.resolve([] as ChunkRow[]),
    mode !== "vector" ? store.ftsSearch(q, { where, limit: k }).catch((e) => { degraded = `fts: ${(e as Error).message}`; return [] as ChunkRow[]; }) : Promise.resolve([] as ChunkRow[]),
  ]);

  const terms = queryTerms(q);
  const fused = cutoff(rrf([{ via: "vector", rows: vecRows }, { via: "keyword", rows: ftsRows }]), terms);
  const byNote = new Map<string, { score: number; chunks: Fused[] }>();
  for (const f of fused) {
    const g = byNote.get(f.row.note_path) ?? { score: 0, chunks: [] };
    g.score = Math.max(g.score, f.score);
    g.chunks.push(f);
    byNote.set(f.row.note_path, g);
  }

  const rest = filters.filter((f) => !LANCE_FIELDS.has(f.field));
  const get = db.prepare("SELECT * FROM notes WHERE path = ?");
  const hits: SearchHit[] = [];
  for (const [path, g] of [...byNote.entries()].sort((a, b) => b[1].score - a[1].score)) {
    const row = get.get(path) as NoteRow | null;
    if (!row) continue; // stale vector index; kb index will drop it
    const fm = JSON.parse(row.fm) as Record<string, unknown>;
    if (!rest.every((f) => matchFilter(row, fm, f))) continue;
    hits.push({
      path, type: row.type, title: row.title, status: row.status, summary: row.summary, tags: JSON.parse(row.tags || "[]"),
      updated: row.updated, archived: !!row.archived, score: round(g.score), confidence: confidence(g.chunks, terms),
      matches: g.chunks.sort((a, b) => b.score - a.score).slice(0, 3).map((c) => ({
        path: c.row.path, heading: c.row.heading, spoiler: c.row.spoiler, via: c.via,
        snippet: c.row.spoiler && !opts.spoilers ? "（ネタバレ：折りたたみ）" : snippet(c.row.text, q),
        ...(c.row._distance != null ? { vectorDistance: round(c.row._distance) } : {}),
        ...(c.row._score != null ? { bm25: round(c.row._score) } : {}),
      })),
    });
    if (hits.length >= limit) break;
  }
  return { hits, mode, degraded };
}

export interface Fused { row: ChunkRow; score: number; via: ("vector" | "keyword")[] }

/** Reciprocal Rank Fusion across retrievers (vector-only thin chunks weighted by THIN_WEIGHT); returns chunk rows sorted by fused score. */
export function rrf(lists: { via: "vector" | "keyword"; rows: ChunkRow[] }[], k = RRF_K, thinWeight = THIN_WEIGHT): Fused[] {
  const acc = new Map<string, Fused>();
  for (const { via, rows } of lists) {
    rows.forEach((row, rank) => {
      const e = acc.get(row.id) ?? { row, score: 0, via: [] };
      // the same chunk from the other retriever carries the other measure (_distance from vector, _score from fts)
      if (e.row !== row) e.row = { ...e.row, ...(row._distance != null ? { _distance: row._distance } : {}), ...(row._score != null ? { _score: row._score } : {}) };
      e.score += 1 / (k + rank + 1);
      e.via.push(via);
      acc.set(row.id, e);
    });
  }
  for (const e of acc.values()) if (e.row.thin && !e.via.includes("keyword")) e.score *= thinWeight;
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Any of the query terms (see queryTerms) occurs literally in the text. */
export function hasTerm(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

/**
 * Relevance cut after fusion: a chunk that only the vector retriever found, farther than `maxDistance`, with none of
 * the query terms in its text, is noise and is dropped. Keyword hits and lexical matches are kept whatever the distance.
 */
export function cutoff(fused: Fused[], terms: string[], maxDistance = VECTOR_CUTOFF): Fused[] {
  return fused.filter((f) => f.via.includes("keyword") || !(f.row._distance! > maxDistance) || hasTerm(f.row.text, terms));
}

/**
 * `high` when some chunk of the note was a keyword hit that literally contains a query term (BM25 alone can match on
 * sub-tokens such as `5` + `G`), or a non-thin chunk is within VECTOR_STRONG of the query. Everything else is `low`:
 * vector-only neighbours between VECTOR_STRONG and VECTOR_CUTOFF, thin (header-only) notes, keyword hits without the term.
 */
export function confidence(chunks: Fused[], terms: string[]): Confidence {
  const strong = chunks.some((c) =>
    (c.via.includes("keyword") && hasTerm(c.row.text, terms)) || (!c.row.thin && c.row._distance != null && c.row._distance <= VECTOR_STRONG));
  return strong ? "high" : "low";
}

export function buildWhere(filters: Filter[], includeArchive: boolean): string | undefined {
  const parts: string[] = [];
  if (!includeArchive) parts.push("archived = false");
  for (const f of filters) {
    if (!LANCE_FIELDS.has(f.field)) continue;
    if (f.op === "=") parts.push(`${f.field} = ${sqlStr(f.value)}`);
    else if (f.op === "!=") parts.push(`${f.field} != ${sqlStr(f.value)}`);
    else if (f.op === "~") parts.push(`${f.field} LIKE ${sqlStr(`%${f.value}%`)}`);
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

/** Same semantics as runQuery's frontmatter filters, evaluated in TS. */
export function matchFilter(row: NoteRow, fm: Record<string, unknown>, f: Filter): boolean {
  const raw = f.field === "tags" ? (JSON.parse(row.tags || "[]") as string[]) : f.field in fm ? fm[f.field] : (row as unknown as Record<string, unknown>)[f.field];
  if (f.field === "tags") {
    const tags = raw as string[];
    return f.op === "~" ? tags.some((t) => t.includes(f.value)) : f.op === "!=" ? !tags.includes(f.value) : tags.includes(f.value);
  }
  if (raw == null) return f.op === "!=";
  const s = Array.isArray(raw) ? raw.map(String).join(",") : String(raw);
  if (f.op === "~") return s.includes(f.value);
  const a = Number(raw), b = Number(f.value);
  const num = !Number.isNaN(a) && !Number.isNaN(b) && f.value !== "";
  const cmp = num ? a - b : s.localeCompare(f.value);
  switch (f.op) {
    case "=": return num ? cmp === 0 : s === f.value;
    case "!=": return num ? cmp !== 0 : s !== f.value;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
  }
}

/**
 * SQLite trigram/LIKE search shaped like hybrid hits (see runQuery for the term handling and ranking).
 * Used as fallback here and directly by the API pod (no Lance there). The single match per note shows the
 * section and text around the first query term in the body, or the summary when the terms only hit metadata.
 */
export function keywordSearch(db: Database, q: string, filters: Filter[], opts: Pick<SearchOpts, "includeArchive" | "limit" | "spoilers">): SearchHit[] {
  const res = runQuery(db, { filters, text: q || undefined, includeArchive: opts.includeArchive, limit: opts.limit ?? 10 });
  const body = db.prepare("SELECT body FROM notes WHERE path = ?");
  const need = q ? queryTerms(q).length : 0; // `high` only when the note contains every term (runQuery's AND pass)
  return res.filter((r) => r.path.startsWith(SILVER_PREFIX)).map((r) => {
    const text = q ? (body.get(r.path) as { body: string } | null)?.body ?? "" : "";
    const m = q ? bodyExcerpt(opts.spoilers ? text : stripSpoilers(text), q) : null;
    return {
      path: r.path, type: r.type, title: r.title, status: r.status, summary: r.summary, tags: r.tags, updated: r.updated, archived: r.archived,
      score: 0, confidence: (r.matched ?? 0) >= need ? "high" : "low",
      matches: [{ path: r.path, heading: m?.heading ?? "", snippet: m?.snippet ?? r.summary, spoiler: false, via: ["keyword"] }],
    };
  });
}

/** ~160 chars around the first query term found, else the beginning. */
export function snippet(text: string, q: string, width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const at = firstIndex(flat, queryTerms(q));
  return at < 0 ? flat.slice(0, width) + "…" : window(flat, at, width);
}

/**
 * Nearest heading above, and ~width chars around, the first query term in a note body; null if none occurs.
 * The leading `# title` line is skipped (a hit there is just the title, which the caller already shows).
 */
export function bodyExcerpt(body: string, q: string, width = 160): { heading: string; snippet: string } | null {
  body = body.replace(/^\s*#\s[^\n]*\n/, "");
  const at = firstIndex(body, queryTerms(q));
  if (at < 0) return null;
  const heading = [...body.slice(0, at).matchAll(/^#{2,6}\s+(.+?)\s*#*\s*$/gm)].pop()?.[1] ?? "";
  return { heading, snippet: window(body, at, width) };
}

function firstIndex(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  return at;
}
function window(text: string, at: number, width: number): string {
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

const round = (x: number) => Math.round(x * 10000) / 10000;
