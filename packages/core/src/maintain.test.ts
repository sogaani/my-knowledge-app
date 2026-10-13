import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLD, isEncryptedPath, loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { buildGold } from "./build";
import { archiveNote, lint, summarizeBronze, validateAll, validateBronze } from "./maintain";
import { mailCategory, readMeta } from "./bronze";
import { SchemaRegistry } from "./schema";

/** A throwaway data repo with a minimal schema set (fixture only; no real sensitive content). */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kb-maintain-"));
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const note = (rel: string, fm: Record<string, unknown>, body = "") =>
    w(rel, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}`);
  const schema = (type: string, folder: string) => w(`900_system/schemas/${type}.json`, JSON.stringify({
    $id: `kb:${type}`, "x-kb": { folder, entity: "file" }, allOf: [{ $ref: "kb:common" }], properties: { type: { const: type } },
  }));
  w("900_system/schemas/_common.json", JSON.stringify({
    $id: "kb:common", type: "object", required: ["type", "title", "status", "created", "updated"],
    properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, related: { type: "array", items: { type: "string" } } },
  }));
  schema("book", "200_silver/204_books");
  schema("review", "200_silver/208_reviews");
  schema("ledger", "200_silver/203_finance");
  schema("project", "200_silver/206_projects");
  w("AGENTS.md", "");
  const base = { status: "open", created: "2026-10-01", summary: "s" };
  note("200_silver/204_books/本A.md", { ...base, type: "book", title: "本A", updated: "2026-10-10" });
  note("200_silver/203_finance/2026-10.md", { ...base, type: "ledger", title: "2026-10", updated: "2026-10-12", summary: "SECRET-SUMMARY" });
  note("200_silver/208_reviews/W41.md", { ...base, type: "review", title: "W41", updated: "2026-10-11", related: ["../203_finance/2026-10.md"] }, "\n[本](../204_books/本A.md) と [台帳](../203_finance/2026-10.md)\n");
  note("200_silver/206_projects/2026-10_個人/README.md", { ...base, type: "project", title: "個人", status: "active", updated: "2026-10-09" });
  note("200_silver/207_work/2026-10_仕事/README.md", { ...base, type: "project", title: "SECRET-WORK", status: "active", updated: "2026-10-13" });
  w("200_silver/206_projects/2026-10_個人/log.md", "# log\n");
  // Bronze metas (local only): a project note + its log, a reviewed mail, an unprocessed mail, a mistyped `kb processed`, and stale / shell-quoted paths
  const bronze = (id: string, kind: string, source: string, processed_to: string[]) =>
    w(`100_bronze/2026/10/${id}/meta.json`, JSON.stringify({ id, kind, source, captured_at: "2026-10-11T00:00:00Z", sha256: "0", files: [source], processed_to }));
  bronze("20261011-note-aaaaaa", "note", "memo.md", ["200_silver/206_projects/2026-10_個人/README.md", "200_silver/206_projects/2026-10_個人/log.md"]);
  bronze("20261011-mail-bbbbbb", "mail", "mail-20261001-finance-0123456789abcdef.json", ["-"]);
  bronze("20261011-mail-cccccc", "mail", "mail-20261002-purchase-0123456789abcdef.json", []);
  bronze("20261011-mail-dddddd", "mail", "mail-20261003-finance-0123456789abcdef.md", ["20261011-mail-bbbbbb", "200_silver/203_finance/2026-10.md"]);
  bronze("20261011-note-eeeeee", "note", "memo2.md", ["200_silver/206_projects/2026-10_旧/README.md", "\"200_silver/204_books/本A.md\"", "-"]);
  return root;
}

describe("isEncryptedPath", () => {
  test("matches the git-crypt domains only", () => {
    expect(isEncryptedPath("200_silver/203_finance/x.md")).toBe(true);
    expect(isEncryptedPath("200_silver/207_work/p/README.md")).toBe(true);
    expect(isEncryptedPath("200_silver/204_books/x.md")).toBe(false);
    expect(isEncryptedPath("300_gold/303_finance.md")).toBe(false);
  });
});

describe("validateAll", () => {
  test("warns when a plaintext note links into an encrypted domain (related or body), not for links between plaintext notes", () => {
    const cfg = loadConfig(fixtureRoot());
    const issues = validateAll(cfg, new SchemaRegistry(cfg));
    const leaks = issues.filter((i) => i.msg.startsWith("plaintext note links into encrypted domain"));
    expect(leaks).toEqual([{ level: "warn", path: "200_silver/208_reviews/W41.md", msg: expect.stringContaining("200_silver/203_finance/2026-10.md") }]);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("buildGold", () => {
  test("plaintext Gold lists encrypted domains by count only", () => {
    const root = fixtureRoot();
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    delete process.env.KB_DB;
    const db = openDb(cfg);
    indexNotes(cfg, db);
    buildGold(cfg, db);
    const home = readFileSync(join(cfg.gold, GOLD.home), "utf8");
    expect(home).toContain("[本A](../200_silver/204_books/本A.md)");
    expect(home).toContain("暗号化ドメインの更新（2026-10-09 以降）: 203_finance 1 件、207_work 1 件");
    expect(home).toContain("進行中 1（仕事 1）");
    expect(home).not.toContain("SECRET");
    expect(home).not.toContain("203_finance/");
    expect(home).not.toContain("207_work/");
    const projects = readFileSync(join(cfg.gold, GOLD.projects), "utf8");
    expect(projects).toContain("仕事（207_work、暗号化）: 進行中 1 件");
    expect(projects).toContain("[個人](../200_silver/206_projects/2026-10_個人/README.md)");
    expect(projects).not.toContain("SECRET");
  });
});

describe("validateBronze", () => {
  test("warns for processed_to entries that are not `-` or an existing Silver path", () => {
    const issues = validateBronze(loadConfig(fixtureRoot()));
    expect(issues.map((i) => [i.level, i.path, i.msg]).sort()).toEqual([
      ["warn", "20261011-mail-dddddd", "processed_to entry is a Bronze ID, not a Silver path: 20261011-mail-bbbbbb"],
      ["warn", "20261011-note-eeeeee", "processed_to entry does not exist (moved to _archive/ or renamed?): 200_silver/206_projects/2026-10_旧/README.md"],
      ["warn", "20261011-note-eeeeee", 'processed_to entry is not a path under 200_silver/: "200_silver/204_books/本A.md"'],
    ]);
  });
  test("is part of validateAll", () => {
    const cfg = loadConfig(fixtureRoot());
    expect(validateAll(cfg, new SchemaRegistry(cfg)).filter((i) => i.path === "20261011-mail-dddddd")).toHaveLength(1);
  });
});

describe("archiveNote", () => {
  test("rewrites Bronze processed_to for the moved entity and its sibling files", () => {
    const cfg = loadConfig(fixtureRoot());
    const r = archiveNote(cfg, "200_silver/206_projects/2026-10_個人", { status: "done" });
    expect(r.to).toBe("200_silver/206_projects/_archive/2026-10_個人");
    expect(r.rewrittenBronze).toEqual(["20261011-note-aaaaaa"]);
    expect(readMeta(cfg, "20261011-note-aaaaaa")!.processed_to).toEqual([
      "200_silver/206_projects/_archive/2026-10_個人/README.md",
      "200_silver/206_projects/_archive/2026-10_個人/log.md",
    ]);
    expect(readMeta(cfg, "20261011-note-eeeeee")!.processed_to[0]).toBe("200_silver/206_projects/2026-10_旧/README.md"); // untouched
    expect(validateBronze(cfg).filter((i) => i.path === "20261011-note-aaaaaa")).toEqual([]);
  });
});

describe("lint bronze summary", () => {
  test("mailCategory reads the collector / Apps Script file name", () => {
    expect(mailCategory({ source: "mail-20261001-finance-0123456789abcdef.json", files: [] })).toBe("finance");
    expect(mailCategory({ source: "Receipt", files: ["mail-20260927-purchase-0123456789abcdef.md"] })).toBe("purchase");
    expect(mailCategory({ source: "memo-2026-10-12-abc.md", files: ["memo-2026-10-12-abc.md"] })).toBeNull();
  });
  test("counts kind × state, mail also per category, kinds by volume", () => {
    const root = fixtureRoot();
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    delete process.env.KB_DB;
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const r = lint(cfg, db);
    expect(r.unprocessedBronze).toEqual(["20261011-mail-cccccc"]);
    expect(r.bronze).toEqual([
      { kind: "mail", total: 3, silver: 1, none: 1, unprocessed: 1 },
      { kind: "mail", category: "finance", total: 2, silver: 1, none: 1, unprocessed: 0 },
      { kind: "mail", category: "purchase", total: 1, silver: 0, none: 0, unprocessed: 1 },
      { kind: "note", total: 2, silver: 2, none: 0, unprocessed: 0 },
    ]);
    expect(summarizeBronze([])).toEqual([]);
  });
});
