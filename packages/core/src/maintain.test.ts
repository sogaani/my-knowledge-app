import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLD, isEncryptedPath, loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { parseNote } from "./frontmatter";
import { runQuery } from "./query";
import { archiveNote, lint, summarizeBronze, validateAll, validateBronze } from "./maintain";
import { buildGold, stockThemes } from "./build";
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
  w("900_system/schemas/project.json", JSON.stringify({
    $id: "kb:project", "x-kb": { folder: "200_silver/206_projects", entity: "folder" }, allOf: [{ $ref: "kb:common" }],
    properties: { type: { const: "project" }, status: { enum: ["idea", "active", "done", "cancelled", "merged"] } },
  }));
  schema("stock", "200_silver/200_market");
  schema("theme", "200_silver/200_market");
  w("AGENTS.md", "");
  const base = { status: "open", created: "2026-10-01", summary: "s" };
  // tags: `mystery` repeats genre, `kobo` repeats platform, `sailing` is used once, `horror` twice
  note("200_silver/204_books/本A.md", { ...base, type: "book", title: "本A", updated: "2026-10-10", tags: ["mystery", "kobo", "horror"], genre: "mystery", platform: "kobo" });
  note("200_silver/204_books/本B.md", { ...base, type: "book", title: "本B", updated: "2026-10-10", tags: ["sailing", "horror"], genre: "nonfiction" });
  // market: themes carry the stock link in `tickers`; 株B also names a theme itself
  note("200_silver/200_market/株A.md", { ...base, type: "stock", title: "株A", status: "holding", updated: "2026-10-10", code: "7974", market: "JP" });
  note("200_silver/200_market/株B.md", { ...base, type: "stock", title: "株B", status: "watch", updated: "2026-10-10", code: "1605", market: "JP", themes: ["テーマ甲"] });
  note("200_silver/200_market/株C.md", { ...base, type: "stock", title: "株C", status: "watch", updated: "2026-10-10", code: "9999", market: "JP" });
  note("200_silver/200_market/テーマ甲.md", { ...base, type: "theme", title: "テーマ甲", status: "active", updated: "2026-10-10", tickers: ["7974", "9697"] });
  note("200_silver/200_market/テーマ乙.md", { ...base, type: "theme", title: "テーマ乙", status: "active", updated: "2026-10-10", tickers: ["1605", "7974"] });
  note("200_silver/203_finance/2026-10.md", { ...base, type: "ledger", title: "2026-10", updated: "2026-10-12", summary: "SECRET-SUMMARY" });
  note("200_silver/208_reviews/W41.md", { ...base, type: "review", title: "W41", updated: "2026-10-11", related: ["../203_finance/2026-10.md"] }, "\n[本](../204_books/本A.md) と [台帳](../203_finance/2026-10.md)\n");
  note("200_silver/206_projects/2026-10_個人/README.md", { ...base, type: "project", title: "個人", status: "active", updated: "2026-10-09" });
  note("200_silver/206_projects/2026-10_まとめ/README.md", { ...base, type: "project", title: "まとめ", status: "active", updated: "2026-10-09" });
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
    expect(home).toContain("進行中 2（仕事 1）");
    expect(home).not.toContain("SECRET");
    expect(home).not.toContain("203_finance/");
    expect(home).not.toContain("207_work/");
    const projects = readFileSync(join(cfg.gold, GOLD.projects), "utf8");
    expect(projects).toContain("仕事（207_work、暗号化）: 進行中 1 件");
    expect(projects).toContain("[個人](../200_silver/206_projects/2026-10_個人/README.md)");
    expect(projects).not.toContain("SECRET");
  });
});

describe("stockThemes", () => {
  test("derives a stock's themes from theme tickers, merged with the stock's own `themes`", () => {
    const root = fixtureRoot();
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    delete process.env.KB_DB;
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const q = (type: string) => runQuery(db, { filters: [{ field: "type", op: "=", value: type }] });
    const m = stockThemes(q("stock"), q("theme"));
    const titles = (p: string) => (m.get(p) ?? []).map((t) => t.title);
    expect(titles("200_silver/200_market/株A.md")).toEqual(["テーマ乙", "テーマ甲"]);
    expect(titles("200_silver/200_market/株B.md")).toEqual(["テーマ乙", "テーマ甲"]);
    expect(m.has("200_silver/200_market/株C.md")).toBe(false);
    buildGold(cfg, db);
    const market = readFileSync(join(cfg.gold, GOLD.market), "utf8");
    expect(market).toContain("| 7974 | [株A](../200_silver/200_market/株A.md) | JP |  | [テーマ乙](../200_silver/200_market/テーマ乙.md)、[テーマ甲](../200_silver/200_market/テーマ甲.md) |");
    expect(market).toContain("| 9999 | [株C](../200_silver/200_market/株C.md) | JP |  |  |");
  });
});

describe("lint tags", () => {
  test("lists single-use tags and tags that repeat genre / platform", () => {
    const root = fixtureRoot();
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    delete process.env.KB_DB;
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const r = lint(cfg, db);
    expect(r.singleUseTags).toEqual(["kobo (200_silver/204_books/本A.md)", "mystery (200_silver/204_books/本A.md)", "sailing (200_silver/204_books/本B.md)"]);
    expect(r.redundantTags).toEqual(["200_silver/204_books/本A.md: mystery (= genre)", "200_silver/204_books/本A.md: kobo (= platform)"]);
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

describe("archiveNote lifecycle", () => {
  test("refuses to archive without a status, or with one the type does not allow", () => {
    const cfg = loadConfig(fixtureRoot());
    const reg = new SchemaRegistry(cfg);
    expect(() => archiveNote(cfg, "200_silver/206_projects/2026-10_個人", { status: "" })).toThrow(/status required/);
    expect(() => archiveNote(cfg, "200_silver/206_projects/2026-10_個人", { status: "finished", reg })).toThrow(/not one of/);
    expect(() => archiveNote(cfg, "200_silver/206_projects/2026-10_個人", { status: "merged", supersededBy: "200_silver/206_projects/2026-10_無い", reg })).toThrow(/superseded_by not found/);
    expect(readFileSync(join(cfg.root, "200_silver/206_projects/2026-10_個人/README.md"), "utf8")).toContain('status: "active"'); // nothing moved
  });
  test("merged: writes the successor as a note-relative superseded_by from the archived location, which validate accepts", () => {
    const cfg = loadConfig(fixtureRoot());
    const reg = new SchemaRegistry(cfg);
    const r = archiveNote(cfg, "200_silver/206_projects/2026-10_個人", { status: "merged", supersededBy: "200_silver/206_projects/2026-10_まとめ", reg });
    const fm = parseNote(readFileSync(join(cfg.root, r.to, "README.md"), "utf8")).fm;
    expect(fm.status).toBe("merged");
    expect(fm.superseded_by).toBe("../../2026-10_まとめ/README.md");
    expect(validateAll(cfg, reg).filter((i) => i.path.includes("2026-10_個人"))).toEqual([]);
  });
});

describe("validateAll superseded_by", () => {
  test("errors on a missing or non-relative successor, warns on merged without one", () => {
    const cfg = loadConfig(fixtureRoot());
    const note = (name: string, fm: string) => {
      mkdirSync(join(cfg.root, `200_silver/206_projects/_archive/${name}`), { recursive: true });
      writeFileSync(join(cfg.root, `200_silver/206_projects/_archive/${name}/README.md`), `---\ntype: project\ntitle: ${name}\nstatus: merged\ncreated: 2026-10-01\nupdated: 2026-10-01\nsummary: s\n${fm}\n---\n`);
    };
    note("a", 'superseded_by: "../../2026-10_まとめ/README.md"');
    note("b", 'superseded_by: "../../2026-10_消えた/README.md"');
    note("c", 'superseded_by: "200_silver/206_projects/2026-10_まとめ/README.md"');
    note("d", "");
    const issues = validateAll(cfg, new SchemaRegistry(cfg)).filter((i) => i.path.includes("/_archive/")).map((i) => [i.level, i.path.split("/")[3], i.msg]).sort((a, b) => a[1]!.localeCompare(b[1]!));
    expect(issues).toEqual([
      ["error", "b", "superseded_by does not exist: ../../2026-10_消えた/README.md"],
      ["error", "c", "superseded_by must be a path relative to the note (like related): 200_silver/206_projects/2026-10_まとめ/README.md"],
      ["warn", "d", "status merged but superseded_by is empty (where did it go?)"],
    ]);
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
