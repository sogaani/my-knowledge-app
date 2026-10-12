/**
 * LanceDB store: one row per chunk of a Silver note, with a dense vector (Ollama) and a BM25
 * full-text index tokenized by Lindera (Japanese) — see lindera.ts. Lives in 900_system/cache/lance (gitignored).
 * Incremental: a per-note content hash decides what gets re-embedded.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "./config";
import { walkNotes, type Note } from "./notes";
import { parseNote } from "./frontmatter";
import { chunkNote, noteHash, CHUNKER_VERSION, type Chunk } from "./chunk";
import type { Embedder } from "./embed";
import { applyLanguageModelHome, resolveTokenizer } from "./lindera";

type Lance = typeof import("@lancedb/lancedb");
type Connection = import("@lancedb/lancedb").Connection;
type Table = import("@lancedb/lancedb").Table;

export const CHUNKS_TABLE = "chunks";

export interface VectorMeta { model: string; dim: number; tokenizer: string; chunker: number; updatedAt: string; rows?: number }

export interface ChunkRow {
  id: string; path: string; note_path: string; idx: number; heading: string; text: string; spoiler: boolean;
  type: string; domain: string; status: string; archived: boolean; updated: string; note_hash: string; vector: number[];
  _distance?: number; _score?: number;
}

export interface EmbedStats { embedded: number; skipped: number; removed: number; chunks: number; rows: number; tokenizer: string; fallback?: string; full: boolean }

let lanceMod: Promise<Lance> | null = null;
/** Lazy so processes that never search (e.g. the API pod) never load the native module. */
export function loadLance(): Promise<Lance> { return (lanceMod ??= import("@lancedb/lancedb")); }

export const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const domainOf = (path: string) => path.split("/")[1] ?? "";

function metaPath(cfg: KbConfig) { return join(cfg.lanceDir, "meta.json"); }
export function readVectorMeta(cfg: KbConfig): VectorMeta | null {
  const p = metaPath(cfg);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as VectorMeta; } catch { return null; }
}

export class VectorStore {
  private constructor(public cfg: KbConfig, private lance: Lance, private conn: Connection, public table: Table | null, public meta: VectorMeta | null) {}

  static async open(cfg: KbConfig): Promise<VectorStore> {
    applyLanguageModelHome(cfg);
    mkdirSync(cfg.lanceDir, { recursive: true });
    const lance = await loadLance();
    const conn = await lance.connect(cfg.lanceDir);
    const names = await conn.tableNames();
    const table = names.includes(CHUNKS_TABLE) ? await conn.openTable(CHUNKS_TABLE) : null;
    return new VectorStore(cfg, lance, conn, table, readVectorMeta(cfg));
  }

  /** Usable for search: table exists and meta describes it. */
  get ready(): boolean { return !!this.table && !!this.meta; }

  async countRows(): Promise<number> { return this.table ? this.table.countRows() : 0; }

  /** Drop everything and create an empty table for the given model/tokenizer. */
  async reset(meta: Omit<VectorMeta, "updatedAt">): Promise<void> {
    const arrow = await import("apache-arrow");
    if (this.table) { await this.conn.dropTable(CHUNKS_TABLE); this.table = null; }
    const f = (name: string, type: any, nullable = false) => new arrow.Field(name, type, nullable);
    const schema = new arrow.Schema([
      f("id", new arrow.Utf8()), f("path", new arrow.Utf8()), f("note_path", new arrow.Utf8()), f("idx", new arrow.Int32()),
      f("heading", new arrow.Utf8()), f("text", new arrow.Utf8()), f("spoiler", new arrow.Bool()),
      f("type", new arrow.Utf8()), f("domain", new arrow.Utf8()), f("status", new arrow.Utf8()), f("archived", new arrow.Bool()),
      f("updated", new arrow.Utf8()), f("note_hash", new arrow.Utf8()),
      f("vector", new arrow.FixedSizeList(meta.dim, new arrow.Field("item", new arrow.Float32(), true))),
    ]);
    this.table = await this.conn.createEmptyTable(CHUNKS_TABLE, schema, { mode: "overwrite" });
    this.writeMeta({ ...meta, updatedAt: new Date().toISOString(), rows: 0 });
  }

  writeMeta(meta: VectorMeta) {
    this.meta = meta;
    writeFileSync(metaPath(this.cfg), JSON.stringify(meta, null, 2) + "\n");
  }

  /** note_path -> note_hash for every indexed note. */
  async existingHashes(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.table) return out;
    const rows = (await this.table.query().select(["note_path", "note_hash"]).toArray()) as { note_path: string; note_hash: string }[];
    for (const r of rows) out.set(r.note_path, r.note_hash);
    return out;
  }

  async deleteNotes(paths: string[]): Promise<void> {
    if (!this.table || !paths.length) return;
    for (let i = 0; i < paths.length; i += 200) {
      await this.table.delete(`note_path IN (${paths.slice(i, i + 200).map(sqlStr).join(", ")})`);
    }
  }

  async addRows(rows: ChunkRow[]): Promise<void> {
    if (!this.table || !rows.length) return;
    await this.table.add(rows as unknown as Record<string, unknown>[]);
  }

  /** Create the BM25 index on `text` once; later rows are folded in by optimize(). */
  async ensureFtsIndex(tokenizer: string): Promise<boolean> {
    if (!this.table) return false;
    const have = (await this.table.listIndices()).some((i) => i.columns.includes("text"));
    if (have) return false;
    if ((await this.table.countRows()) === 0) return false;
    await this.table.createIndex("text", {
      config: this.lance.Index.fts({ baseTokenizer: tokenizer as any, withPosition: false, lowercase: true, stem: false, removeStopWords: false, asciiFolding: true }),
      replace: true,
    });
    return true;
  }

  async optimize(): Promise<void> {
    if (this.table) await this.table.optimize();
  }

  async vectorSearch(vector: number[], opts: { where?: string; limit: number }): Promise<ChunkRow[]> {
    if (!this.table) return [];
    let q = this.table.vectorSearch(vector).distanceType("cosine").limit(opts.limit).select(SELECT_COLS);
    if (opts.where) q = q.where(opts.where);
    return (await q.toArray()) as ChunkRow[];
  }

  async ftsSearch(text: string, opts: { where?: string; limit: number }): Promise<ChunkRow[]> {
    if (!this.table) return [];
    let q = this.table.search(text, "fts", "text").limit(opts.limit).select(SELECT_COLS);
    if (opts.where) q = q.where(opts.where);
    return (await q.toArray()) as ChunkRow[];
  }
}

const SELECT_COLS = ["id", "path", "note_path", "idx", "heading", "text", "spoiler", "type", "domain", "status", "archived", "updated"];

export interface EmbedRunOpts { full?: boolean; log?: (s: string) => void }

/** Incrementally (re)embed every Silver note into the store. Throws if Ollama is unusable — callers decide whether that is fatal. */
export async function embedNotes(cfg: KbConfig, store: VectorStore, embedder: Embedder, opts: EmbedRunOpts = {}): Promise<EmbedStats> {
  const log = opts.log ?? (() => {});
  const tok = resolveTokenizer(cfg);
  if (tok.fallback) log(`fts tokenizer: ${tok.tokenizer} (fallback: ${tok.fallback})`);
  const ping = await embedder.ping();
  if (!ping.ok) throw new Error(ping.reason);
  const dim = embedder.profile.dim || (await embedder.embed(["dimension probe"], "doc"))[0].length;

  const want = { model: embedder.profile.model, dim, tokenizer: tok.tokenizer, chunker: CHUNKER_VERSION };
  const m = store.meta;
  const mismatch = !store.ready || !m || m.model !== want.model || m.dim !== want.dim || m.tokenizer !== want.tokenizer || m.chunker !== want.chunker;
  const full = !!opts.full || mismatch;
  if (full) {
    log(mismatch && m ? `index built for ${m.model}/${m.dim}/${m.tokenizer}/v${m.chunker}; rebuilding for ${want.model}/${want.dim}/${want.tokenizer}/v${want.chunker}` : "building vector index");
    await store.reset(want);
  }

  const existing = await store.existingHashes();
  const seen = new Set<string>();
  const stats: EmbedStats = { embedded: 0, skipped: 0, removed: 0, chunks: 0, rows: 0, tokenizer: tok.tokenizer, fallback: tok.fallback, full };
  const pending: { note: Note; chunks: Chunk[]; hash: string }[] = [];

  for (const n of walkNotes(cfg, { dirs: [cfg.silver], includeArchive: true })) {
    seen.add(n.path);
    const atts = n.attachments.map((p) => ({ path: p, body: parseNote(readFileSync(join(cfg.root, p), "utf8")).body }));
    const hash = noteHash(n, atts);
    if (existing.get(n.path) === hash) { stats.skipped++; continue; }
    pending.push({ note: n, chunks: chunkNote(n, atts), hash });
  }

  const GROUP = 8;
  for (let i = 0; i < pending.length; i += GROUP) {
    const group = pending.slice(i, i + GROUP);
    const chunks = group.flatMap((g) => g.chunks);
    const vectors = await embedder.embed(chunks.map((c) => c.embedText), "doc");
    const rows: ChunkRow[] = [];
    let vi = 0;
    for (const g of group) {
      for (const c of g.chunks) {
        rows.push({
          id: c.id, path: c.path, note_path: c.notePath, idx: c.idx, heading: c.heading, text: c.text, spoiler: c.spoiler,
          type: g.note.type, domain: domainOf(g.note.path), status: g.note.status, archived: g.note.archived,
          updated: String(g.note.fm.updated ?? ""), note_hash: g.hash, vector: vectors[vi++],
        });
      }
    }
    await store.deleteNotes(group.map((g) => g.note.path));
    await store.addRows(rows);
    stats.embedded += group.length;
    stats.chunks += rows.length;
    log(`embedded ${Math.min(i + GROUP, pending.length)}/${pending.length} notes (${stats.chunks} chunks)`);
  }

  const gone = [...existing.keys()].filter((p) => !seen.has(p));
  if (gone.length) { await store.deleteNotes(gone); stats.removed = gone.length; }

  if (stats.embedded || stats.removed || full) {
    if (await store.ensureFtsIndex(tok.tokenizer)) log(`created fts index (${tok.tokenizer})`);
    await store.optimize();
  }
  stats.rows = await store.countRows();
  store.writeMeta({ ...want, updatedAt: new Date().toISOString(), rows: stats.rows });
  return stats;
}
