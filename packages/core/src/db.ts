import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { KbConfig } from "./config";
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
`;

export function openDb(cfg: KbConfig): Database {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new Database(cfg.dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000"); // the worker's search loop and `kb` subprocesses write the same file
  db.exec(SCHEMA);
  return db;
}

const LINK_RE = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

/**
 * Full or incremental re-index of Silver + Gold. Returns counts.
 * `paths` (repo-relative files or folders, e.g. from `git diff --name-only`) limits the walk to those notes,
 * so a single edit does not re-read every file.
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
  return { added, updated, removed };
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

/** Resolve markdown links + `related:` entries to repo-relative paths. */
export function extractLinks(n: Note): string[] {
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
  for (const rel of (Array.isArray(n.fm.related) ? n.fm.related : []) as string[]) {
    const r = resolveRel(String(rel));
    if (r) out.add(r);
  }
  return [...out];
}
