import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { today, type KbConfig } from "./config";
import { decodeText } from "./text";
import { digestJson } from "./collect/digest";

export type BronzeKind = "web" | "note" | "mail" | "file" | "book" | "image" | "feed";

export interface BronzeMeta {
  id: string;
  kind: BronzeKind;
  source: string; // original URL or filename
  captured_at: string;
  sha256: string;
  files: string[];
  title?: string;
  processed_to: string[]; // silver paths (or the 900_system/articles day file for rss feeds); ["-"] = reviewed, nothing to reflect in Silver (`kb processed <id> --none`)
  notes?: string;
}

const ACCESS_LOG = "access.jsonl";

export function logAccess(cfg: KbConfig, event: Record<string, unknown>) {
  mkdirSync(cfg.logs, { recursive: true });
  appendFileSync(join(cfg.logs, ACCESS_LOG), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

function sha256(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function guessKind(p: string): BronzeKind {
  const e = extname(p).toLowerCase();
  if ([".eml", ".msg"].includes(e)) return "mail";
  if ((e === ".md" || e === ".json") && /^mail-/.test(basename(p))) return "mail"; // Gmail (mail-YYYYMMDD-<slug>-<id>.md from the old Apps Script push, .json from the collector)
  if (e === ".json" && /^collect-/.test(basename(p))) return "feed"; // collector feeds (collect-<source>-<from>_<to>.json)
  if ([".epub", ".mobi"].includes(e)) return "book";
  if ([".png", ".jpg", ".jpeg", ".heic", ".webp"].includes(e)) return "image";
  if ([".md", ".txt"].includes(e)) return "note";
  return "file";
}

export function bronzeDir(cfg: KbConfig, id: string): string {
  const y = id.slice(0, 4), m = id.slice(4, 6);
  return join(cfg.bronze, y, m, id);
}

/**
 * Move a local file (usually from 000_inbox) into Bronze. Returns meta.
 * A file whose content is already in Bronze (same SHA-256, any day) is not stored again: the inbox copy is dropped
 * and the existing item is returned with `duplicate: true` (e.g. the same Timeline export dropped twice).
 */
export function ingestFile(cfg: KbConfig, src: string, opts: { kind?: BronzeKind; keep?: boolean; title?: string; sourceLabel?: string } = {}): BronzeMeta & { duplicate?: true } {
  const buf = readFileSync(src);
  const hash = sha256(buf);
  const same = findBySha256(cfg, hash);
  if (same) {
    if (!opts.keep) unlinkSync(src);
    return { ...same, duplicate: true };
  }
  const kind = opts.kind ?? guessKind(src);
  const id = `${today().replace(/-/g, "")}-${kind}-${hash.slice(0, 6)}`;
  const dir = bronzeDir(cfg, id);
  if (existsSync(dir)) {
    // same content captured the same day: idempotent. Drop the inbox copy too, or `kb inbox` keeps listing it forever
    // (a re-run ingest job re-stages the same files).
    if (!opts.keep) unlinkSync(src);
    return readMeta(cfg, id)!;
  }
  mkdirSync(dir, { recursive: true });
  const name = basename(src);
  opts.keep ? copyFileSync(src, join(dir, name)) : renameSync(src, join(dir, name));
  const meta: BronzeMeta = {
    id, kind, source: opts.sourceLabel ?? name, captured_at: new Date().toISOString(), sha256: hash,
    files: [name], title: opts.title, processed_to: [],
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/** Fetch a URL, store raw HTML + readable Markdown in Bronze. */
export async function ingestUrl(cfg: KbConfig, url: string): Promise<BronzeMeta> {
  const res = await fetch(url, { headers: { "user-agent": "my-knowledge-kb/0.1 (+personal)" } });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const html = await res.text();
  const { htmlToMarkdown } = await import("./html");
  const { title, markdown } = htmlToMarkdown(html, url);
  const hash = sha256(url);
  const id = `${today().replace(/-/g, "")}-web-${hash.slice(0, 6)}`;
  const dir = bronzeDir(cfg, id);
  if (existsSync(dir)) return readMeta(cfg, id)!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "page.html"), html);
  writeFileSync(join(dir, "page.md"), `# ${title}\n\nSource: ${url}\n\n${markdown}`);
  const meta: BronzeMeta = {
    id, kind: "web", source: url, captured_at: new Date().toISOString(), sha256: sha256(html),
    files: ["page.html", "page.md"], title, processed_to: [],
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/** The Bronze item holding exactly this content, if any (ingestUrl hashes the URL, so web captures never match). */
export function findBySha256(cfg: KbConfig, hash: string): BronzeMeta | null {
  for (const m of walkBronze(cfg)) if (m.sha256 === hash && m.kind !== "web") return m;
  return null;
}

export function readMeta(cfg: KbConfig, id: string): BronzeMeta | null {
  const p = join(bronzeDir(cfg, id), "meta.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BronzeMeta) : null;
}

function writeMeta(cfg: KbConfig, meta: BronzeMeta) {
  writeFileSync(join(bronzeDir(cfg, meta.id), "meta.json"), JSON.stringify(meta, null, 2));
}

export function markProcessed(cfg: KbConfig, id: string, silverPaths: string[]) {
  const meta = readMeta(cfg, id);
  if (!meta) return;
  meta.processed_to = [...new Set([...meta.processed_to, ...silverPaths])];
  writeMeta(cfg, meta);
}

/**
 * A Silver entity moved from `fromRel` to `toRel` (repo-relative, e.g. `kb archive`): point every processed_to entry at
 * (or under, for folder entities) the old path to the new one. Returns the ids rewritten.
 */
export function rewriteProcessedTo(cfg: KbConfig, fromRel: string, toRel: string): string[] {
  const changed: string[] = [];
  for (const m of walkBronze(cfg)) {
    const next = m.processed_to.map((p) => (p === fromRel ? toRel : p.startsWith(fromRel + "/") ? toRel + p.slice(fromRel.length) : p));
    if (next.every((p, i) => p === m.processed_to[i])) continue;
    m.processed_to = [...new Set(next)];
    writeMeta(cfg, m);
    changed.push(m.id);
  }
  return changed;
}

/** Where a Bronze item ended up: in Silver, reviewed with nothing to reflect (`-` only), or not yet processed. */
export type ProcessState = "silver" | "none" | "unprocessed";
export function processState(meta: Pick<BronzeMeta, "processed_to">): ProcessState {
  if (!meta.processed_to.length) return "unprocessed";
  return meta.processed_to.every((p) => p === "-") ? "none" : "silver";
}

/** Gmail category from the file name the collector / Apps Script push used (mail-YYYYMMDD-<category>-<id>.*), or null. */
export function mailCategory(meta: Pick<BronzeMeta, "source" | "files">): string | null {
  for (const name of [meta.source, ...meta.files]) {
    const m = /^mail-\d{8}-([a-z]+)-/.exec(basename(name));
    if (m) return m[1];
  }
  return null;
}

/** Return meta + an excerpt (first N chars of the best text file). Logs the access. */
export function sourceExcerpt(cfg: KbConfig, id: string, opts: { full?: boolean; chars?: number } = {}) {
  const meta = readMeta(cfg, id);
  if (!meta) return null;
  const dir = bronzeDir(cfg, id);
  const textFile = meta.files.find((f) => f.endsWith(".md")) ?? meta.files.find((f) => /\.(txt|csv|eml|html|json)$/i.test(f));
  let text = "", truncated = false;
  if (textFile) {
    text = decodeText(readFileSync(join(dir, textFile)));
    // collector JSON: show the readable digest; --full still returns the raw JSON
    if (textFile.endsWith(".json") && !opts.full) text = digestJson(text) ?? text;
    const limit = opts.chars ?? (meta.kind === "feed" ? 6000 : 1500);
    if (!opts.full && text.length > limit) { text = text.slice(0, limit); truncated = true; }
  }
  logAccess(cfg, { op: "source", id, full: !!opts.full, bytes: text.length });
  return { meta, text, truncated };
}

/** List inbox entries (files only; skips hidden). */
export function listInbox(cfg: KbConfig): string[] {
  if (!existsSync(cfg.inbox)) return [];
  return readdirSync(cfg.inbox).filter((f) => !f.startsWith(".")).map((f) => join(cfg.inbox, f));
}

/** Iterate all bronze metas (for lint / prune). */
export function* walkBronze(cfg: KbConfig): Generator<BronzeMeta> {
  if (!existsSync(cfg.bronze)) return;
  for (const y of readdirSync(cfg.bronze)) {
    const yd = join(cfg.bronze, y);
    if (!statSync(yd).isDirectory()) continue;
    for (const m of readdirSync(yd)) {
      const md = join(yd, m);
      if (!statSync(md).isDirectory()) continue;
      for (const id of readdirSync(md)) {
        const meta = readMeta(cfg, id);
        if (meta) yield meta;
      }
    }
  }
}
