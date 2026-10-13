import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { SILVER_PREFIX, WORK_FOLDER, isEncryptedPath, today, type KbConfig } from "./config";
import { parseNote, stringifyNote } from "./frontmatter";
import { walkNotes, type Note } from "./notes";
import type { SchemaRegistry } from "./schema";
import { listInbox, mailCategory, processState, readMeta, rewriteProcessedTo, walkBronze, type ProcessState } from "./bronze";

export interface Issue { level: "error" | "warn"; path: string; msg: string }

const BRONZE_ID = /^\d{8}-[a-z]+-[0-9a-f]{6}$/;

/** Validate every Silver note (schema, links, sources, plaintext → encrypted-domain links) and Bronze processed_to. Gold is skipped (generated). */
export function validateAll(cfg: KbConfig, reg: SchemaRegistry): Issue[] {
  const issues: Issue[] = [];
  const notes = [...walkNotes(cfg, { dirs: [cfg.silver] })];
  const paths = new Set(notes.map((n) => n.path));
  for (const n of notes) {
    for (const e of reg.validate(n.fm)) issues.push({ level: "error", path: n.path, msg: e });
    const def = reg.get(n.type);
    if (def && !n.path.startsWith(def.folder + "/") && !n.path.startsWith(WORK_FOLDER + "/")) {
      issues.push({ level: "error", path: n.path, msg: `type ${n.type} belongs in ${def.folder}/` });
    }
    if (!n.summary) issues.push({ level: "warn", path: n.path, msg: "summary is empty" });
    const plaintext = !isEncryptedPath(n.path);
    for (const dst of linksOf(n)) {
      if (!paths.has(dst) && !existsSync(join(cfg.root, dst))) issues.push({ level: "error", path: n.path, msg: `broken link: ${dst}` });
      // a plaintext note that links into a git-crypt domain tends to carry its content along (title, summary): keep to counts / aggregates
      if (plaintext && isEncryptedPath(dst)) issues.push({ level: "warn", path: n.path, msg: `plaintext note links into encrypted domain: ${dst} (refer by count / aggregate only)` });
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
  issues.push(...validateBronze(cfg));
  return issues;
}

/**
 * Bronze → Silver record: every processed_to entry is `-` or an existing Silver path. Catches paths left behind by a move
 * (`kb archive` before it rewrote Bronze), Bronze IDs passed to `kb processed` by mistake, and shell-quoted names.
 * Warnings only (Bronze is local to the Mac; the pre-commit validate must not fail on it). `path` is the Bronze id.
 */
export function validateBronze(cfg: KbConfig): Issue[] {
  const issues: Issue[] = [];
  for (const m of walkBronze(cfg)) {
    for (const p of m.processed_to) {
      if (p === "-") continue;
      const why = BRONZE_ID.test(p) ? "is a Bronze ID, not a Silver path"
        : !p.startsWith(SILVER_PREFIX) ? `is not a path under ${SILVER_PREFIX}`
        : !existsSync(join(cfg.root, p)) ? "does not exist (moved to _archive/ or renamed?)"
        : null;
      if (why) issues.push({ level: "warn", path: m.id, msg: `processed_to entry ${why}: ${p}` });
    }
  }
  return issues;
}

function linksOf(n: Note): string[] {
  const { extractLinks } = require("./db") as typeof import("./db");
  return extractLinks(n);
}

/** Move a Silver note (or folder entity) into its domain's _archive/ and rewrite inbound links and Bronze processed_to. */
export function archiveNote(cfg: KbConfig, relPath: string, opts: { status?: string } = {}): { from: string; to: string; rewritten: string[]; rewrittenBronze: string[] } {
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
  const rewrittenBronze = rewriteProcessedTo(cfg, fromRel, toRel);
  return { from: fromRel, to: toRel, rewritten, rewrittenBronze };
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

export interface LintReport {
  inboxStale: string[]; orphans: string[]; stale: string[]; renewals: string[]; archiveCandidates: string[]; unprocessedBronze: string[];
  /** Bronze items per kind (and per Gmail category for mail) by processing state: how much of what comes in ends up in Silver. */
  bronze: BronzeSummary[];
}
export interface BronzeSummary { kind: string; category?: string; total: number; silver: number; none: number; unprocessed: number }

export function lint(cfg: KbConfig, db: Database, opts: { staleDays?: number } = {}): LintReport {
  const now = Date.now();
  const days = (iso: string) => (now - new Date(iso).getTime()) / 86400000;
  const inboxStale = listInbox(cfg).filter((f) => days(statSync(f).mtime.toISOString()) > 3).map((f) => basename(f));
  const linked = new Set((db.query("SELECT DISTINCT dst FROM links").all() as { dst: string }[]).map((r) => r.dst));
  const rows = db.query("SELECT path, type, status, updated, fm FROM notes WHERE archived=0 AND path LIKE ?").all(`${SILVER_PREFIX}%`) as
    { path: string; type: string; status: string; updated: string; fm: string }[];
  const orphans: string[] = [], stale: string[] = [], renewals: string[] = [], archiveCandidates: string[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.fm) as Record<string, unknown>;
    if (!linked.has(r.path) && !["review", "trade_plan"].includes(r.type)) orphans.push(r.path);
    if (["project", "learning"].includes(r.type) && r.status === "active" && r.updated && days(r.updated) > (opts.staleDays ?? 30)) stale.push(r.path);
    if (r.type === "subscription" && r.status === "active" && fm.next_renewal && days(String(fm.next_renewal)) > -14) renewals.push(`${r.path} (${fm.next_renewal})`);
    if (["done", "cancelled", "closed"].includes(r.status)) archiveCandidates.push(r.path);
  }
  const metas = [...walkBronze(cfg)];
  const unprocessedBronze = metas.filter((m) => processState(m) === "unprocessed").map((m) => m.id);
  return { inboxStale, orphans, stale, renewals, archiveCandidates, unprocessedBronze, bronze: summarizeBronze(metas) };
}

/** kind × processing state, with mail also split by Gmail category (a category that is mostly `-` is a label rule to revisit). */
export function summarizeBronze(metas: { kind: string; source: string; files: string[]; processed_to: string[] }[]): BronzeSummary[] {
  const rows = new Map<string, BronzeSummary>();
  const add = (kind: string, category: string | undefined, state: ProcessState) => {
    const key = category ? `${kind}/${category}` : kind;
    const row = rows.get(key) ?? { kind, ...(category ? { category } : {}), total: 0, silver: 0, none: 0, unprocessed: 0 };
    row.total++;
    row[state]++;
    rows.set(key, row);
  };
  for (const m of metas) {
    const state = processState(m);
    add(m.kind, undefined, state);
    if (m.kind === "mail") add(m.kind, mailCategory(m) ?? "other", state);
  }
  // kinds by volume, each kind's categories right after it
  return [...rows.values()].sort((a, b) =>
    a.kind !== b.kind ? (rows.get(b.kind)?.total ?? 0) - (rows.get(a.kind)?.total ?? 0) || a.kind.localeCompare(b.kind)
      : (a.category ? 1 : 0) - (b.category ? 1 : 0) || b.total - a.total || (a.category ?? "").localeCompare(b.category ?? ""));
}
