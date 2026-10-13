import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { fillTemplate, parseNote, stringifyNote } from "./frontmatter";
import { slugify, toRel } from "./notes";
import type { SchemaRegistry } from "./schema";

export interface CreateOpts {
  type: string;
  title: string;
  set?: Record<string, unknown>;
  force?: boolean;
  folder?: string; // override target subfolder (e.g. for work projects: 200_silver/207_work)
}

/**
 * Monthly log types (one note per month) and the label their title carries: `2026-10 家計`, not a bare `2026-10` that
 * four domains would share (search results and lists could not tell them apart). The file stays `YYYY-MM.md`.
 */
export const MONTHLY_TYPES: Record<string, string> = { ledger: "家計", health_log: "健康記録", location_log: "滞在記録", calendar_log: "予定" };
const MONTH_RE = /^\d{4}-\d{2}$/;
/** Title of a monthly note: `YYYY-MM <label>` (the month alone for a type that is not monthly). */
export function monthlyTitle(type: string, month: string): string {
  const label = MONTHLY_TYPES[type];
  return label ? `${month} ${label}` : month;
}
/** True when a monthly note's title is a bare `YYYY-MM` (the pre-convention form). */
export function isBareMonthTitle(type: string, title: string): boolean {
  return !!MONTHLY_TYPES[type] && MONTH_RE.test(title.trim());
}

export class DuplicateError extends Error {
  constructor(public matches: { path: string; title: string }[]) {
    super(`possible duplicate: ${matches.map((m) => m.path).join(", ")}`);
  }
}

/** Create a Silver note (or folder entity) from its template. Returns repo-relative path of the note. */
export function createNote(cfg: KbConfig, reg: SchemaRegistry, db: Database | null, o: CreateOpts): string {
  const def = reg.get(o.type);
  if (!def) throw new Error(`unknown type ${o.type}`);
  // monthly types: `kb new ledger "2026-10"` becomes title `2026-10 家計`, month 2026-10, file 2026-10.md
  let title = o.title.trim(), slug = slugify(title), set = o.set;
  if (MONTHLY_TYPES[o.type]) {
    const month = typeof set?.month === "string" && MONTH_RE.test(set.month) ? set.month : (/^(\d{4}-\d{2})(\s|$)/.exec(title)?.[1] ?? "");
    if (!month) throw new Error(`${o.type} is a monthly note: kb new ${o.type} "${monthlyTitle(o.type, "YYYY-MM")}"`);
    if (MONTH_RE.test(title)) title = monthlyTitle(o.type, month);
    slug = month;
    set = { ...set, month };
  }
  if (db && !o.force) {
    const dups = findDuplicates(db, o.type, title, set);
    if (dups.length) throw new DuplicateError(dups);
  }
  const tplPath = join(cfg.templates, `${o.type}.md`);
  if (!existsSync(tplPath)) throw new Error(`template missing: ${tplPath}`);
  const vars = { title, today: today() };
  let text = fillTemplate(readFileSync(tplPath, "utf8"), vars);
  if (set && Object.keys(set).length) {
    const { fm, body } = parseNote(text);
    Object.assign(fm, reg.coerce(o.type, set));
    text = stringifyNote(fm, body);
  }
  const folder = join(cfg.root, o.folder ?? def.folder);
  let absNote: string;
  if (def.entity === "folder") {
    const dirName = `${today().slice(0, 7)}_${slug}`;
    const dir = join(folder, dirName);
    if (existsSync(dir)) throw new Error(`exists: ${dir}`);
    mkdirSync(dir, { recursive: true });
    absNote = join(dir, "README.md");
    writeFileSync(absNote, text);
    for (const extra of ["log", "tasks"]) {
      const t = join(cfg.templates, `${o.type}.${extra}.md`);
      if (existsSync(t)) writeFileSync(join(dir, `${extra}.md`), fillTemplate(readFileSync(t, "utf8"), vars));
    }
  } else {
    mkdirSync(folder, { recursive: true });
    absNote = join(folder, `${slug}.md`);
    if (existsSync(absNote)) throw new Error(`exists: ${absNote}`);
    writeFileSync(absNote, text);
  }
  return toRel(cfg, absNote);
}

export function findDuplicates(db: Database, type: string, title: string, set?: Record<string, unknown>) {
  const rows = db.query("SELECT path, title, fm FROM notes WHERE type=?").all(type) as { path: string; title: string; fm: string }[];
  const norm = (s: string) => s.toLowerCase().replace(/[\s　・:：\-—–]/g, "");
  const t = norm(title);
  const out: { path: string; title: string }[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.fm) as Record<string, unknown>;
    const same = norm(r.title) === t
      || (set?.month && fm.month && String(fm.month) === String(set.month)) // monthly types: one note per month
      || (set?.isbn && fm.isbn && String(fm.isbn) === String(set.isbn))
      || (set?.service && fm.service && norm(String(fm.service)) === norm(String(set.service)));
    if (same) out.push({ path: r.path, title: r.title });
  }
  return out;
}

/** Update frontmatter fields of an existing note in place (used by `kb set` and the API's light edits). */
export function patchFrontmatter(abs: string, patch: Record<string, unknown>, reg?: SchemaRegistry): Record<string, unknown> {
  const { fm, body } = parseNote(readFileSync(abs, "utf8"));
  if (reg) patch = reg.coerce(String(fm.type ?? ""), patch);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete fm[k];
    else fm[k] = v;
  }
  fm.updated = today();
  writeFileSync(abs, stringifyNote(fm, body));
  return fm;
}

/** Append a dated bullet to a section of a note (creates the section if missing). */
export function appendToSection(abs: string, heading: string, line: string) {
  const text = readFileSync(abs, "utf8");
  const { fm, body } = parseNote(text);
  const h = `## ${heading}`;
  const idx = body.indexOf(h);
  let newBody: string;
  if (idx === -1) newBody = body.trimEnd() + `\n\n${h}\n- ${today()}: ${line}\n`;
  else {
    const after = body.indexOf("\n## ", idx + h.length);
    const end = after === -1 ? body.length : after;
    const section = body.slice(idx, end).trimEnd();
    newBody = body.slice(0, idx) + section + `\n- ${today()}: ${line}\n` + (after === -1 ? "" : "\n" + body.slice(after + 1));
  }
  fm.updated = today();
  writeFileSync(abs, stringifyNote(fm, newBody));
}
