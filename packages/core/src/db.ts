import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GOLD, GOLD_PREFIX, SILVER_PREFIX, type KbConfig } from "./config";
import { readNote, toRel, walkNotes, type Note } from "./notes";

export interface NoteRow {
  path: string;
  type: string;
  title: string;
  status: string;
  summary: string;
  tags: string; // JSON
  fm: string; // JSON
  archived: number;
  mtime: number;
  updated: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  tags TEXT,
  fm TEXT NOT NULL,
  body TEXT,
  archived INTEGER DEFAULT 0,
  mtime REAL,
  updated TEXT
);
CREATE INDEX IF NOT EXISTS notes_type ON notes(type);
CREATE TABLE IF NOT EXISTS links (src TEXT, dst TEXT, PRIMARY KEY(src, dst));
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, summary, tags, body, tokenize='trigram');
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS similar (path TEXT NOT NULL, other TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY(path, other));
`;

/**
 * Bump whenever SCHEMA or what indexNotes extracts per note changes. The index file persists across restarts (Mac:
 * 900_system/cache, API pod: the kb-state volume) and is only refreshed incrementally by mtime, so without this an old
 * file would keep serving rows shaped by the previous code. On a mismatch openDb drops every table and the next
 * indexNotes rebuilds from scratch.
 */
export const INDEX_VERSION = 1;
const INDEX_TABLES = ["notes_fts", "notes", "links", "similar", "meta"];

export function openDb(cfg: KbConfig): Database {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new Database(cfg.dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000"); // the worker's search loop and `kb` subprocesses write the same file
  if (indexVersion(db) !== INDEX_VERSION) {
    for (const t of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(SCHEMA);
    db.run("INSERT INTO meta(k,v) VALUES('index_version',?)", [String(INDEX_VERSION)]);
  } else {
    db.exec(SCHEMA);
  }
  return db;
}

/** Stored INDEX_VERSION, or null for a new file or one from before versioning (no `meta` table / row). */
function indexVersion(db: Database): number | null {
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!has) return null;
  const row = db.query("SELECT v FROM meta WHERE k='index_version'").get() as { v: string } | null;
  return row ? Number(row.v) : null;
}

/** True when nothing has been indexed into this file yet (fresh volume or just reset by a version bump). */
export function indexIsEmpty(db: Database): boolean {
  return !db.query("SELECT 1 FROM notes LIMIT 1").get();
}

const LINK_RE = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

/**
 * Full or incremental re-index of Silver. Returns counts.
 * `paths` (repo-relative files or folders, e.g. from `git diff --name-only`) limits the walk to those notes,
 * so a single edit does not re-read every file.
 * Gold never enters `notes` / the FTS (it is derived and must not show up in search); only its links into Silver go
 * into `links`, so "listed in a Gold view" counts as a backlink (lint orphans, the WebUI's 被リンク).
 */
export function indexNotes(cfg: KbConfig, db: Database, opts: { full?: boolean; paths?: string[] } = {}) {
  const existing = new Map<string, number>(
    (db.query("SELECT path, mtime FROM notes").all() as { path: string; mtime: number }[]).map((r) => [r.path, r.mtime]),
  );
  const seen = new Set<string>();
  let added = 0, updated = 0, removed = 0;
  const upsert = db.prepare(`INSERT INTO notes(path,type,title,status,summary,tags,fm,body,archived,mtime,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET type=excluded.type,title=excluded.title,status=excluded.status,summary=excluded.summary,
      tags=excluded.tags,fm=excluded.fm,body=excluded.body,archived=excluded.archived,mtime=excluded.mtime,updated=excluded.updated`);
  const delFts = db.prepare("DELETE FROM notes_fts WHERE path=?");
  const insFts = db.prepare("INSERT INTO notes_fts(path,title,summary,tags,body) VALUES(?,?,?,?,?)");
  const delLinks = db.prepare("DELETE FROM links WHERE src=?");
  const delGoldLinks = db.prepare("DELETE FROM links WHERE src LIKE ?");
  const insLink = db.prepare("INSERT OR IGNORE INTO links(src,dst) VALUES(?,?)");

  const scope = opts.paths ? notesUnder(cfg, opts.paths) : { notes: [...walkNotes(cfg)], covers: () => true };
  const tx = db.transaction((notes: Note[]) => {
    for (const n of notes) {
      seen.add(n.path);
      const prev = existing.get(n.path);
      if (!opts.full && prev !== undefined && prev === n.mtime) continue;
      prev === undefined ? added++ : updated++;
      upsert.run(n.path, n.type, n.title, n.status, n.summary, JSON.stringify(n.tags), JSON.stringify(n.fm), n.body,
        n.archived ? 1 : 0, n.mtime, String(n.fm.updated ?? ""));
      delFts.run(n.path);
      insFts.run(n.path, n.title, n.summary, n.tags.join(" "), n.body);
      delLinks.run(n.path);
      for (const dst of extractLinks(n)) insLink.run(n.path, dst);
    }
    // Gold is small (a few dozen files) and rewritten whole by `kb build`: re-extract its links every time
    delGoldLinks.run(`${GOLD_PREFIX}%`);
    for (const [src, dst] of goldLinks(cfg)) insLink.run(src, dst);
    for (const p of existing.keys()) {
      if (!seen.has(p) && scope.covers(p)) {
        db.run("DELETE FROM notes WHERE path=?", [p]);
        delFts.run(p);
        delLinks.run(p);
        removed++;
      }
    }
    db.run("INSERT OR REPLACE INTO meta(k,v) VALUES('indexed_at',?)", [new Date().toISOString()]);
  });
  tx(scope.notes);
  loadSimilar(cfg, db);
  return { added, updated, removed };
}

/** `900_system/similar.json`: nearest notes per note, written by `kb embed` (vector.ts) and committed with the data repo. */
export interface SimilarFile { model: string; chunker: number; updatedAt: string; k: number; pairs: [string, string, number][] }

/**
 * Load `900_system/similar.json` into the `similar` table when the file changed since the last load (mtime + size in
 * `meta`). Runs on every indexNotes, so the API pod (which never embeds) picks the pairs up from git with its next sync.
 */
export function loadSimilar(cfg: KbConfig, db: Database): boolean {
  const p = cfg.similarPath;
  if (!existsSync(p)) return false;
  const st = statSync(p);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const prev = (db.query("SELECT v FROM meta WHERE k='similar_loaded'").get() as { v: string } | null)?.v;
  if (prev === stamp) return false;
  let file: SimilarFile;
  try { file = JSON.parse(readFileSync(p, "utf8")) as SimilarFile; } catch { return false; }
  if (!Array.isArray(file.pairs)) return false;
  const ins = db.prepare("INSERT OR REPLACE INTO similar(path,other,score) VALUES(?,?,?)");
  db.transaction(() => {
    db.run("DELETE FROM similar");
    for (const [path, other, score] of file.pairs) ins.run(path, other, score);
    db.run("INSERT OR REPLACE INTO meta(k,v) VALUES('similar_loaded',?)", [stamp]);
  })();
  return true;
}

export interface SimilarNote { path: string; type: string; title: string; status: string; summary: string; score: number }
/** Nearest notes of `path` (best first) that are still in the index, from `similar` joined with `notes`. */
export function similarNotes(db: Database, path: string, limit = 5): SimilarNote[] {
  return db.query(`SELECT n.path, n.type, n.title, n.status, n.summary, s.score FROM similar s JOIN notes n ON n.path = s.other
    WHERE s.path = ? AND n.archived = 0 AND n.path LIKE ? ORDER BY s.score DESC, n.path LIMIT ?`).all(path, `${SILVER_PREFIX}%`, limit) as SimilarNote[];
}

/** Notes at or below the given repo-relative paths (Silver/Gold only), and which index rows those paths cover. */
function notesUnder(cfg: KbConfig, paths: string[]): { notes: Note[]; covers: (p: string) => boolean } {
  const roots = [cfg.silver, cfg.gold].map((d) => `${toRel(cfg, d)}/`);
  const files = new Set<string>(), dirs: string[] = [];
  for (const raw of paths) {
    const p = raw.replace(/^\/+|\/+$/g, "");
    if (!roots.some((r) => `${p}/`.startsWith(r))) continue;
    const abs = join(cfg.root, p);
    const isDir = existsSync(abs) ? statSync(abs).isDirectory() : !p.endsWith(".md");
    if (isDir) {
      if (existsSync(join(abs, "README.md"))) files.add(`${p}/README.md`);
      else dirs.push(p);
    } else if (p.endsWith(".md")) {
      // log.md / tasks.md of a folder entity belong to its README.md note
      const dir = dirname(p);
      files.add(basename(p) !== "README.md" && existsSync(join(cfg.root, dir, "README.md")) ? `${dir}/README.md` : p);
    }
  }
  const notes: Note[] = [];
  for (const f of files) {
    const abs = join(cfg.root, f);
    const n = existsSync(abs) ? readNote(cfg, abs) : null;
    if (n) notes.push(n);
  }
  if (dirs.length) notes.push(...walkNotes(cfg, { dirs: dirs.map((d) => join(cfg.root, d)) }));
  return { notes, covers: (p) => files.has(p) || dirs.some((d) => p.startsWith(`${d}/`)) };
}

/**
 * [gold path, silver path] for every markdown link from a Gold file into Silver (Gold has no frontmatter, so it is not a Note).
 * 393 (resurface) is skipped: its random picks and review reminders rotate daily and list orphans on purpose, so they must
 * not count as backlinks (an orphan would stop being one for a day).
 */
export function goldLinks(cfg: KbConfig): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith(".md")) {
        const src = toRel(cfg, abs);
        if (src === `${GOLD_PREFIX}${GOLD.resurface}`) continue;
        for (const dst of extractLinks({ path: src, body: readFileSync(abs, "utf8"), fm: {} })) if (dst.startsWith(SILVER_PREFIX)) out.push([src, dst]);
      }
    }
  };
  walk(cfg.gold);
  return out;
}

/** Resolve markdown links, `related:` entries and `superseded_by` to repo-relative paths. */
export function extractLinks(n: Pick<Note, "path" | "body" | "fm">): string[] {
  const base = n.path.split("/").slice(0, -1);
  const out = new Set<string>();
  const resolveRel = (target: string) => {
    if (target.startsWith("http")) return null;
    const parts = [...base];
    for (const seg of target.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    return parts.join("/");
  };
  for (const m of n.body.matchAll(LINK_RE)) {
    const r = resolveRel(m[1]);
    if (r) out.add(r);
  }
  // superseded_by is note-relative like related; a repo-relative value is a validate error, not a link
  const successor = typeof n.fm.superseded_by === "string" && n.fm.superseded_by && !/^(\/|\d{3}_)/.test(n.fm.superseded_by) ? [n.fm.superseded_by] : [];
  for (const rel of [...((Array.isArray(n.fm.related) ? n.fm.related : []) as string[]), ...successor]) {
    const r = resolveRel(String(rel));
    if (r) out.add(r);
  }
  return [...out];
}
