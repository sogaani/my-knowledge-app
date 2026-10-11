import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { parseNote, type Frontmatter } from "./frontmatter";
import type { KbConfig } from "./config";

export interface Note {
  path: string; // relative to root, posix
  absPath: string;
  type: string;
  title: string;
  status: string;
  summary: string;
  tags: string[];
  fm: Frontmatter;
  body: string;
  archived: boolean;
  mtime: number;
  /** For folder entities: sibling files (log.md, tasks.md) */
  attachments: string[];
}

const SKIP = new Set([".gitkeep", ".DS_Store"]);

/** Walk 20_silver and 30_gold and yield every note (README.md of folder entities counts as the note). */
export function* walkNotes(cfg: KbConfig, opts: { includeArchive?: boolean; dirs?: string[] } = {}): Generator<Note> {
  const dirs = opts.dirs ?? [cfg.silver, cfg.gold];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    yield* walkDir(cfg, dir, opts.includeArchive ?? true);
  }
}

function* walkDir(cfg: KbConfig, dir: string, includeArchive: boolean): Generator<Note> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "_archive" && !includeArchive) continue;
      if (existsSync(join(abs, "README.md"))) {
        const n = readNote(cfg, join(abs, "README.md"));
        if (n) {
          n.attachments = readdirSync(abs).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => toRel(cfg, join(abs, f)));
          yield n;
        }
        continue;
      }
      yield* walkDir(cfg, abs, includeArchive);
    } else if (ent.name.endsWith(".md")) {
      const n = readNote(cfg, abs);
      if (n) yield n;
    }
  }
}

export function toRel(cfg: KbConfig, abs: string): string {
  return relative(cfg.root, abs).split("\\").join("/");
}

export function readNote(cfg: KbConfig, abs: string): Note | null {
  const text = readFileSync(abs, "utf8");
  const { fm, body, hasFm } = parseNote(text);
  if (!hasFm || !fm.type) return null;
  const rel = toRel(cfg, abs);
  return {
    path: rel,
    absPath: abs,
    type: String(fm.type),
    title: String(fm.title ?? basename(abs, ".md")),
    status: String(fm.status ?? ""),
    summary: String(fm.summary ?? ""),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    fm,
    body,
    archived: rel.includes("/_archive/"),
    mtime: statSync(abs).mtimeMs,
    attachments: [],
  };
}

/** Human-visible identity of a note: the folder for folder entities, else the file. */
export function noteDisplayPath(n: Note): string {
  return n.path.endsWith("/README.md") ? dirname(n.path) : n.path;
}

export function slugify(title: string): string {
  // keep Japanese; drop punctuation; spaces -> hyphen
  return title
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~\[\]`]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
