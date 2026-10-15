import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { SILVER_PREFIX, WORK_FOLDER, isEncryptedPath, today, type KbConfig } from "./config";
import { parseNote, stringifyNote } from "./frontmatter";
import { walkNotes, type Note } from "./notes";
import type { SchemaRegistry } from "./schema";
import { listInbox, mailCategory, processState, readMeta, rewriteProcessedTo, walkBronze, type ProcessState } from "./bronze";
import { SUGGESTION_SOURCE_PREFIX, relLink, suggestionIds } from "./suggest";
import { MONTHLY_TYPES, isBareMonthTitle, monthlyTitle } from "./create";
import { STALE_DAYS, isStale } from "./resurface";
import { ARTICLES_DIR } from "./articles";

export interface Issue { level: "error" | "warn"; path: string; msg: string }

const BRONZE_ID = /^\d{8}-[a-z]+-[0-9a-f]{6}$/;

/** Validate every Silver note (schema, links, sources, plaintext → encrypted-domain links) and Bronze processed_to. Gold is skipped (generated). */
export function validateAll(cfg: KbConfig, reg: SchemaRegistry): Issue[] {
  const issues: Issue[] = [];
  const notes = [...walkNotes(cfg, { dirs: [cfg.silver] })];
  const paths = new Set(notes.map((n) => n.path));
  const suggestions = suggestionIds(cfg, notes);
  for (const n of notes) {
    for (const e of reg.validate(n.fm)) issues.push({ level: "error", path: n.path, msg: e });
    const def = reg.get(n.type);
    if (def && !n.path.startsWith(def.folder + "/") && !n.path.startsWith(WORK_FOLDER + "/")) {
      issues.push({ level: "error", path: n.path, msg: `type ${n.type} belongs in ${def.folder}/` });
    }
    if (!n.summary) issues.push({ level: "warn", path: n.path, msg: "summary is empty" });
    // monthly notes name their type in the title: four domains share the month, and a list of `2026-10`s tells nothing
    if (isBareMonthTitle(n.type, n.title)) issues.push({ level: "warn", path: n.path, msg: `monthly note title should name its type: "${monthlyTitle(n.type, n.title.trim())}"` });
    // lifecycle: a merged / superseded note names its successor (a note-relative path, like `related`), and the successor exists
    const successor = supersededBy(n);
    if (successor) {
      if (successor.abs && !paths.has(successor.rel) && !existsSync(join(cfg.root, successor.rel))) issues.push({ level: "error", path: n.path, msg: `superseded_by does not exist: ${successor.raw}` });
      else if (!successor.abs) issues.push({ level: "error", path: n.path, msg: `superseded_by must be a path relative to the note (like related): ${successor.raw}` });
    } else if (n.status === "merged") issues.push({ level: "warn", path: n.path, msg: "status merged but superseded_by is empty (where did it go?)" });
    const plaintext = !isEncryptedPath(n.path);
    for (const dst of linksOf(n)) {
      if (dst === successor?.rel) continue; // reported above
      if (!paths.has(dst) && !existsSync(join(cfg.root, dst))) issues.push({ level: "error", path: n.path, msg: `broken link: ${dst}` });
      // a plaintext note that links into a git-crypt domain tends to carry its content along (title, summary): keep to counts / aggregates
      if (plaintext && isEncryptedPath(dst)) issues.push({ level: "warn", path: n.path, msg: `plaintext note links into encrypted domain: ${dst} (refer by count / aggregate only)` });
    }
    for (const s of (n.fm.sources as string[] | undefined) ?? []) {
      if (/^https?:/.test(s)) continue;
      if (s.startsWith(SUGGESTION_SOURCE_PREFIX)) {
        // a note made from a suggestion: the id must still be in some recommendation note (archived ones count)
        if (!suggestions.has(s.slice(SUGGESTION_SOURCE_PREFIX.length))) issues.push({ level: "error", path: n.path, msg: `sources entry names an unknown suggestion id: ${s}` });
        continue;
      }
      if (!/^\d{8}-[a-z]+-[0-9a-f]{6}$/.test(s)) issues.push({ level: "error", path: n.path, msg: `sources entry is not a Bronze ID, URL or suggestion:<id>: ${s}` });
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
 * Bronze → Silver record: every processed_to entry is `-`, an existing Silver path, or (rss feeds) the day file under
 * 900_system/articles/ the curate run wrote. Catches paths left behind by a move
 * (`kb archive` before it rewrote Bronze), Bronze IDs passed to `kb processed` by mistake, and shell-quoted names.
 * Warnings only (Bronze is local to the Mac; the pre-commit validate must not fail on it). `path` is the Bronze id.
 */
export function validateBronze(cfg: KbConfig): Issue[] {
  const issues: Issue[] = [];
  for (const m of walkBronze(cfg)) {
    for (const p of m.processed_to) {
      if (p === "-") continue;
      const why = BRONZE_ID.test(p) ? "is a Bronze ID, not a Silver path"
        : !(p.startsWith(SILVER_PREFIX) || p.startsWith(`${ARTICLES_DIR}/`)) ? `is not a path under ${SILVER_PREFIX} or ${ARTICLES_DIR}/`
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

/** `superseded_by` of a note resolved to a repo-relative path (`abs` false when it is not a note-relative path). */
function supersededBy(n: Note): { raw: string; rel: string; abs: boolean } | null {
  const raw = n.fm.superseded_by;
  if (typeof raw !== "string" || !raw) return null;
  const ok = !raw.startsWith("/") && !raw.startsWith(SILVER_PREFIX) && !/^https?:/.test(raw);
  return { raw, rel: ok ? posix.normalize(posix.join(posix.dirname(n.path), raw)) : raw, abs: ok };
}

export interface ArchiveOpts {
  /** Final status written into the note (required: an archived note says why it ended). */
  status: string;
  /** Repo-relative path of the note this one was merged into / replaced by; written as a note-relative `superseded_by`. */
  supersededBy?: string;
  /** When given, `status` must be one of the type's statuses (and `supersededBy` must exist) before anything moves. */
  reg?: SchemaRegistry;
}

/**
 * Move a Silver note (or folder entity) into its domain's _archive/, set its final status (and successor), and rewrite
 * inbound links and Bronze processed_to.
 */
export function archiveNote(cfg: KbConfig, relPath: string, opts: ArchiveOpts): { from: string; to: string; rewritten: string[]; rewrittenBronze: string[] } {
  if (!opts?.status) throw new Error("status required: an archived note must say why it ended (done / cancelled / merged / closed …)");
  let abs = join(cfg.root, relPath);
  if (!existsSync(abs)) throw new Error(`not found: ${relPath}`);
  const isFolder = statSync(abs).isDirectory() || basename(abs) === "README.md";
  const entity = statSync(abs).isDirectory() ? abs : isFolder ? dirname(abs) : abs;
  if (entity.includes("/_archive/")) throw new Error("already archived");
  const srcNote = statSync(entity).isDirectory() ? join(entity, "README.md") : entity;
  const { fm, body } = parseNote(readFileSync(srcNote, "utf8"));
  const def = opts.reg?.get(String(fm.type ?? ""));
  if (def && def.statuses.length && !def.statuses.includes(opts.status)) throw new Error(`status ${opts.status} is not one of ${def.statuses.join("|")} for type ${def.type}`);
  let successor = opts.supersededBy?.replace(/^\/+/, "");
  if (successor) {
    const sAbs = join(cfg.root, successor);
    if (!existsSync(sAbs)) throw new Error(`superseded_by not found: ${successor}`);
    if (statSync(sAbs).isDirectory()) successor = `${successor.replace(/\/$/, "")}/README.md`;
  }
  const domain = dirname(entity);
  const target = join(domain, "_archive", basename(entity));
  mkdirSync(join(domain, "_archive"), { recursive: true });
  renameSync(entity, target);
  const notePath = statSync(target).isDirectory() ? join(target, "README.md") : target;
  const toRel = relative(cfg.root, target).split("\\").join("/");
  fm.status = opts.status;
  if (successor) fm.superseded_by = relLink(statSync(target).isDirectory() ? `${toRel}/README.md` : toRel, successor);
  fm.updated = today();
  writeFileSync(notePath, stringifyNote(fm, body));
  const fromRel = relative(cfg.root, entity).split("\\").join("/");
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
  /** Tags used by exactly one note (`tag (path)`): not a cross-cutting topic, so fold into a field or drop. */
  singleUseTags: string[];
  /** Tags that repeat a dedicated field of the same note (`path: tag (= genre)`): genre / subgenre / platform / kind own that information. */
  redundantTags: string[];
  /** Bronze items per kind (and per Gmail category for mail) by processing state: how much of what comes in ends up in Silver. */
  bronze: BronzeSummary[];
}
export interface BronzeSummary { kind: string; category?: string; total: number; silver: number; none: number; unprocessed: number }

export function lint(cfg: KbConfig, db: Database, opts: { staleDays?: number } = {}): LintReport {
  const now = Date.now();
  const todayStr = today();
  const days = (iso: string) => (now - new Date(iso).getTime()) / 86400000;
  const inboxStale = listInbox(cfg).filter((f) => days(statSync(f).mtime.toISOString()) > 3).map((f) => basename(f));
  // inbound links from Silver notes and from Gold (`kb build` lists every book / ledger / log in its views; a note on a
  // Gold page is not orphaned). Gold links are indexed from the files on disk, so run `kb build` before judging.
  const linked = new Set((db.query("SELECT DISTINCT dst FROM links").all() as { dst: string }[]).map((r) => r.dst));
  const rows = db.query("SELECT path, type, status, updated, fm FROM notes WHERE archived=0 AND path LIKE ?").all(`${SILVER_PREFIX}%`) as
    { path: string; type: string; status: string; updated: string; fm: string }[];
  const orphans: string[] = [], stale: string[] = [], renewals: string[] = [], archiveCandidates: string[] = [];
  const tagUses = new Map<string, string[]>();
  const redundantTags: string[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.fm) as Record<string, unknown>;
    for (const t of tagsOf(fm)) {
      tagUses.set(t, [...(tagUses.get(t) ?? []), r.path]);
      const field = TAG_FIELDS.find((f) => typeof fm[f] === "string" && String(fm[f]).toLowerCase() === t.toLowerCase());
      if (field) redundantTags.push(`${r.path}: ${t} (= ${field})`);
    }
    if (!linked.has(r.path) && !ORPHAN_EXEMPT.has(r.type)) orphans.push(r.path);
    if (isStale(r, todayStr, opts.staleDays ?? STALE_DAYS)) stale.push(r.path); // the same rule feeds 393_resurface
    if (r.type === "subscription" && r.status === "active" && fm.next_renewal && days(String(fm.next_renewal)) > -14) renewals.push(`${r.path} (${fm.next_renewal})`);
    if (["done", "cancelled", "closed", "merged"].includes(r.status)) archiveCandidates.push(r.path);
  }
  const singleUseTags = [...tagUses].filter(([, ps]) => ps.length === 1).map(([t, ps]) => `${t} (${ps[0]})`).sort();
  const metas = [...walkBronze(cfg)];
  const unprocessedBronze = metas.filter((m) => processState(m) === "unprocessed").map((m) => m.id);
  return { inboxStale, orphans, stale, renewals, archiveCandidates, unprocessedBronze, singleUseTags, redundantTags, bronze: summarizeBronze(metas) };
}

/**
 * Types nobody links to by design: reviews and daily trade sheets are read in sequence, and the monthly logs
 * (ledger / health / location / calendar) are containers an importer fills; `related` to them says nothing.
 */
const ORPHAN_EXEMPT = new Set(["review", "trade_plan", ...Object.keys(MONTHLY_TYPES)]);

/** Fields that hold what a tag must not repeat: tags are for topics that cut across domains, not genre / platform / origin. */
const TAG_FIELDS = ["genre", "subgenre", "platform", "kind"] as const;
const tagsOf = (fm: Record<string, unknown>) => (Array.isArray(fm.tags) ? fm.tags : []).map(String);

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
