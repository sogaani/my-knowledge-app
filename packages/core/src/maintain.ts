import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { parseNote, stringifyNote } from "./frontmatter";
import { walkNotes, type Note } from "./notes";
import type { SchemaRegistry } from "./schema";
import { listInbox, readMeta, walkBronze } from "./bronze";

export interface Issue { level: "error" | "warn"; path: string; msg: string }

/** Validate every Silver note: schema, links, sources. Gold is skipped (generated). */
export function validateAll(cfg: KbConfig, reg: SchemaRegistry): Issue[] {
  const issues: Issue[] = [];
  const notes = [...walkNotes(cfg, { dirs: [cfg.silver] })];
  const paths = new Set(notes.map((n) => n.path));
  for (const n of notes) {
    for (const e of reg.validate(n.fm)) issues.push({ level: "error", path: n.path, msg: e });
    const def = reg.get(n.type);
    if (def && !n.path.startsWith(def.folder + "/") && !n.path.startsWith("20_silver/27_work/")) {
      issues.push({ level: "error", path: n.path, msg: `type ${n.type} belongs in ${def.folder}/` });
    }
    if (!n.summary) issues.push({ level: "warn", path: n.path, msg: "summary is empty" });
    for (const dst of linksOf(n)) {
      if (!paths.has(dst) && !existsSync(join(cfg.root, dst))) issues.push({ level: "error", path: n.path, msg: `broken link: ${dst}` });
    }
    for (const s of (n.fm.sources as string[] | undefined) ?? []) {
      if (/^https?:/.test(s)) continue;
      if (!/^\d{8}-[a-z]+-[0-9a-f]{6}$/.test(s)) issues.push({ level: "error", path: n.path, msg: `sources entry is not a Bronze ID or URL: ${s}` });
      else if (!readMeta(cfg, s)) issues.push({ level: "warn", path: n.path, msg: `Bronze ${s} not present on this machine` });
    }
    const text = readFileSync(n.absPath, "utf8");
    if (/(^|[^0-9-])[0-9]{7,}([^0-9-]|$)/.test(text.replace(/https?:\/\/[^\s)>\]]+|isbn:.*|sha256.*|\d{8}-[a-z]+-[0-9a-f]{6}|^\s*(total|total_value|buying_power|cash_jpy|cash_usd|margin_deposit|fx_usdjpy|positions):\s*-?[\d.]+\s*$/gim, ""))) {
      issues.push({ level: "error", path: n.path, msg: "long digit run (account/card number?)" });
    }
  }
  return issues;
}

function linksOf(n: Note): string[] {
  const { extractLinks } = require("./db") as typeof import("./db");
  return extractLinks(n);
}

/** Move a Silver note (or folder entity) into its domain's _archive/ and rewrite inbound links. */
export function archiveNote(cfg: KbConfig, relPath: string, opts: { status?: string } = {}): { from: string; to: string; rewritten: string[] } {
  let abs = join(cfg.root, relPath);
  if (!existsSync(abs)) throw new Error(`not found: ${relPath}`);
  const isFolder = statSync(abs).isDirectory() || basename(abs) === "README.md";
  const entity = statSync(abs).isDirectory() ? abs : isFolder ? dirname(abs) : abs;
  if (entity.includes("/_archive/")) throw new Error("already archived");
  const domain = dirname(entity);
  const target = join(domain, "_archive", basename(entity));
  mkdirSync(join(domain, "_archive"), { recursive: true });
  renameSync(entity, target);
  const notePath = statSync(target).isDirectory() ? join(target, "README.md") : target;
  if (opts.status) {
    const { fm, body } = parseNote(readFileSync(notePath, "utf8"));
    fm.status = opts.status;
    fm.updated = today();
    writeFileSync(notePath, stringifyNote(fm, body));
  }
  const fromRel = relative(cfg.root, entity).split("\\").join("/");
  const toRel = relative(cfg.root, target).split("\\").join("/");
  const rewritten = rewriteLinks(cfg, fromRel, toRel);
  return { from: fromRel, to: toRel, rewritten };
}

function rewriteLinks(cfg: KbConfig, fromRel: string, toRel: string): string[] {
  const changed: string[] = [];
  for (const n of walkNotes(cfg, { dirs: [cfg.silver] })) {
    const text = readFileSync(n.absPath, "utf8");
    const dir = dirname(n.path);
    const oldLink = relPosix(dir, fromRel);
    const newLink = relPosix(dir, toRel);
    if (!text.includes(oldLink)) continue;
    writeFileSync(n.absPath, text.split(oldLink).join(newLink));
    changed.push(n.path);
  }
  return changed;
}
function relPosix(fromDir: string, to: string): string {
  const r = relative(fromDir, to).split("\\").join("/");
  return r.startsWith(".") ? r : "./" + r;
}

export interface LintReport { inboxStale: string[]; orphans: string[]; stale: string[]; renewals: string[]; archiveCandidates: string[]; unprocessedBronze: string[] }

export function lint(cfg: KbConfig, db: Database, opts: { staleDays?: number } = {}): LintReport {
  const now = Date.now();
  const days = (iso: string) => (now - new Date(iso).getTime()) / 86400000;
  const inboxStale = listInbox(cfg).filter((f) => days(statSync(f).mtime.toISOString()) > 3).map((f) => basename(f));
  const linked = new Set((db.query("SELECT DISTINCT dst FROM links").all() as { dst: string }[]).map((r) => r.dst));
  const rows = db.query("SELECT path, type, status, updated, fm FROM notes WHERE archived=0 AND path LIKE '20_silver/%'").all() as
    { path: string; type: string; status: string; updated: string; fm: string }[];
  const orphans: string[] = [], stale: string[] = [], renewals: string[] = [], archiveCandidates: string[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.fm) as Record<string, unknown>;
    if (!linked.has(r.path) && !["review", "trade_plan"].includes(r.type)) orphans.push(r.path);
    if (["project", "learning"].includes(r.type) && r.status === "active" && r.updated && days(r.updated) > (opts.staleDays ?? 30)) stale.push(r.path);
    if (r.type === "subscription" && r.status === "active" && fm.next_renewal && days(String(fm.next_renewal)) > -14) renewals.push(`${r.path} (${fm.next_renewal})`);
    if (["done", "cancelled", "closed"].includes(r.status)) archiveCandidates.push(r.path);
  }
  const unprocessedBronze = [...walkBronze(cfg)].filter((m) => m.processed_to.length === 0).map((m) => m.id);
  return { inboxStale, orphans, stale, renewals, archiveCandidates, unprocessedBronze };
}
