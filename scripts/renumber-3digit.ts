#!/usr/bin/env bun
/**
 * One-off migration (2026-10): two-digit folder numbers → three digits by inserting a 0 after the layer digit.
 *   00_inbox → 000_inbox, 20_silver/24_books → 200_silver/204_books, 30_gold/37_suggestions.md → 300_gold/307_suggestions.md
 *
 * usage: bun scripts/renumber-3digit.ts <repo> [--apply] [--move] [--bronze]
 *   (default)  dry run: list files whose text would change
 *   --apply    rewrite path tokens in git-tracked text files (+ .gitignore / .gitattributes)
 *   --move     rename the numbered folders and Gold files on disk (data repo only)
 *   --bronze   rewrite `processed` paths in 100_bronze/**\/meta.json (data repo only, run after --move)
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAMES = [
  "inbox", "bronze", "silver", "gold", "templates", "system",
  "market", "learning", "subscriptions", "finance", "books", "media", "projects", "work", "reviews", "people",
  "home", "suggestions", "trading",
];
// Not preceded by a digit/letter (so 2026_x or v20_x stay), followed by a known name.
const TOKEN = new RegExp(`(?<![0-9A-Za-z])([0-9])([0-9])_(${NAMES.join("|")})(?![A-Za-z])`, "g");
export const renumber = (s: string) => s.replace(TOKEN, "$10$2_$3");

const [repo, ...flags] = process.argv.slice(2);
if (!repo || !existsSync(join(repo, ".git"))) { console.error("usage: bun scripts/renumber-3digit.ts <repo> [--apply] [--move] [--bronze]"); process.exit(1); }
const has = (f: string) => flags.includes(f);

if (has("--move")) {
  // Children first (Silver domains, Gold entries), then the layer folders themselves.
  for (const layer of ["20_silver", "30_gold"]) {
    const dir = join(repo, layer);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir)) {
      const to = renumber(e);
      if (to !== e) { renameSync(join(dir, e), join(dir, to)); console.log(`mv ${layer}/${e} -> ${to}`); }
    }
  }
  for (const e of readdirSync(repo)) {
    const to = renumber(e);
    if (to !== e) { renameSync(join(repo, e), join(repo, to)); console.log(`mv ${e} -> ${to}`); }
  }
}

// After --move the index still lists the old paths: map each to where it lives now.
const tracked = (await Bun.$`git -C ${repo} ls-files -z`.text()).split("\0").filter(Boolean)
  .map((f) => (existsSync(join(repo, f)) ? f : renumber(f)));
const files = [...new Set([...tracked, ".gitignore", ".gitattributes"])].filter((f) => !f.endsWith("renumber-3digit.ts") && existsSync(join(repo, f)) && statSync(join(repo, f)).isFile());
let changed = 0;
for (const f of files) {
  const abs = join(repo, f);
  const buf = readFileSync(abs);
  if (buf.includes(0) || buf.subarray(0, 10).toString("latin1").startsWith("\0GITCRYPT")) continue; // binary or still-encrypted
  const text = buf.toString("utf8");
  const next = renumber(text);
  if (next === text) continue;
  changed++;
  if (has("--apply")) writeFileSync(abs, next); else console.log(`would rewrite ${f}`);
}
console.log(`${has("--apply") ? "rewrote" : "would rewrite"} ${changed} file(s)`);

if (has("--bronze")) {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "meta.json") {
        const t = readFileSync(p, "utf8"), u = renumber(t);
        if (u !== t) { writeFileSync(p, u); n++; }
      }
    }
  };
  const bronze = join(repo, "100_bronze");
  if (existsSync(bronze)) walk(bronze);
  console.log(`bronze meta rewritten: ${n}`);
}
