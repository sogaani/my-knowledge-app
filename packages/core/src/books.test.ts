import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLD, loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { parseNote } from "./frontmatter";
import { runQuery } from "./query";
import { readMeta } from "./bronze";
import { SchemaRegistry } from "./schema";
import { buildGold } from "./build";
import { IMPORTED_SUMMARY, bookYear, importKoboLibrary, parseImportedSummary, parseKoboCsv, unratedImported } from "./books";

/** Throwaway data repo: book schema + template, a few book notes, a Kobo library export in Bronze (fixture only). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-books-"));
  const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  const note = (rel: string, fm: Record<string, unknown>) => w(rel, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n# x\n`);
  w("900_system/schemas/_common.json", JSON.stringify({
    $id: "kb:common", type: "object", required: ["type", "title", "status", "created", "updated"],
    properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, sources: { type: "array" } },
  }));
  w("900_system/schemas/book.json", JSON.stringify({
    $id: "kb:book", "x-kb": { folder: "200_silver/204_books", entity: "file" }, allOf: [{ $ref: "kb:common" }],
    properties: { type: { const: "book" }, status: { enum: ["want", "reading", "read", "dnf"] }, isbn: { type: "string" }, publisher: { type: "string" }, purchased_at: { type: "string", format: "date" }, imported: { type: "boolean" } },
  }));
  w("800_templates/book.md", '---\ntype: book\ntitle: "{{title}}"\nstatus: want\ntags: []\ncreated: {{today}}\nupdated: {{today}}\nsources: []\nrelated: []\nsummary: ""\nauthor: ""\ngenre: ""\nplatform: ""\n---\n\n# {{title}}\n\n## 概要（ネタバレなし）\n\n## 感想（ネタバレなし）\n');
  w("AGENTS.md", "");
  const base = { type: "book", status: "read", created: "2026-10-11", updated: "2026-10-12", tags: [] };
  note("200_silver/204_books/読了A.md", { ...base, title: "読了A", summary: "感想あり", rating: 4, finished_at: "2026-10-02" });
  note("200_silver/204_books/取込B.md", { ...base, title: "取込B", summary: IMPORTED_SUMMARY, imported: true, purchased_at: "2025-03-01", author: "著者B" });
  note("200_silver/204_books/取込C.md", { ...base, title: "取込C", summary: IMPORTED_SUMMARY, imported: true, purchased_at: "2024-12-31", author: "著者C" });
  note("200_silver/204_books/取込D.md", { ...base, title: "取込D", summary: "読み直した", imported: true, purchased_at: "2025-01-05", rating: 5 });
  note("200_silver/204_books/日付なしE.md", { ...base, title: "日付なしE", summary: "" });
  note("200_silver/204_books/積読F.md", { ...base, title: "積読F", status: "want", summary: "", imported: true, purchased_at: "2026-10-01" });
  const csv = [
    "productId,isbn,adultType,title,authorName,companyName,imageUrl,detailUrl,addDate",
    '"p1","8932131710500","1","取込B","著者B","社B","https://img/1.jpg","https://books.example/p1","2025-03-01 19:18:52"', // already a note (title)
    '"p2","9784000000001","1","新刊G","著者G","社G","https://img/2.jpg","https://books.example/p2","2026-10-05 08:00:00"',
    '"p3","9784000000002","1","新刊, H","著者H","社H","https://img/3.jpg","https://books.example/p3","2026-10-06 08:00:00"',
    '"p3","9784000000002","1","新刊, H","著者H","社H","https://img/3.jpg","https://books.example/p3","2026-10-06 08:00:00"', // duplicate row
  ].join("\n");
  w("100_bronze/2026/10/20261013-file-abcdef/kobo.csv", csv);
  w("100_bronze/2026/10/20261013-file-abcdef/meta.json", JSON.stringify({ id: "20261013-file-abcdef", kind: "file", source: "kobo.csv", captured_at: "2026-10-13T00:00:00Z", sha256: "0", files: ["kobo.csv"], processed_to: [] }));
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  const db = openDb(cfg);
  indexNotes(cfg, db);
  return { root, cfg, db, reg: new SchemaRegistry(cfg) };
}

describe("parseImportedSummary", () => {
  test("extracts publisher and purchase date from the 2026-10 bulk-import summary, with or without a genre word", () => {
    expect(parseImportedSummary("著者Xのミステリ（出版社Y）。楽天Kobo で 2025-08-05 に購入、読了（ライブラリ一括取り込み。2026-10-13 に本人が全て読了と確認）"))
      .toEqual({ publisher: "出版社Y", purchased_at: "2025-08-05" });
    expect(parseImportedSummary("著者X（出版社Y）。楽天Kobo で 2025-02-05 に購入、読了（ライブラリ一括取り込み。2026-10-13 に本人が全て読了と確認）"))
      .toEqual({ publisher: "出版社Y", purchased_at: "2025-02-05" });
    expect(parseImportedSummary("孤島の本格ミステリ。読了")).toBeNull();
    expect(parseImportedSummary("")).toBeNull();
  });
});

describe("bookYear / unratedImported", () => {
  test("finished_at wins, purchased_at is the fallback, neither → unknown", () => {
    expect(bookYear({ finished_at: "2026-10-02", purchased_at: "2025-01-01" })).toBe("2026");
    expect(bookYear({ purchased_at: "2025-03-01" })).toBe("2025");
    expect(bookYear({ finished_at: "", purchased_at: "" })).toBe("unknown");
    expect(bookYear({})).toBe("unknown");
  });
  test("imported + read + no rating, oldest purchase first", () => {
    const { db } = fixture();
    const books = runQuery(db, { filters: [{ field: "type", op: "=", value: "book" }] });
    expect(unratedImported(books).map((b) => b.title)).toEqual(["取込C", "取込B"]);
  });
});

describe("runQuery on book fields", () => {
  test("imported=true matches the YAML boolean; rating= matches an unset field", () => {
    const { db } = fixture();
    const titles = (filters: string[]) => runQuery(db, {
      filters: filters.map((t) => { const [field, value] = t.split("="); return { field, op: "=" as const, value }; }), orderBy: "title",
    }).map((b) => b.title);
    expect(titles(["imported=true"])).toEqual(["取込B", "取込C", "取込D", "積読F"]);
    expect(titles(["status=read", "imported=true", "rating="])).toEqual(["取込B", "取込C"]);
    expect(runQuery(db, { filters: [{ field: "rating", op: "!=", value: "" }], orderBy: "title" }).map((b) => b.title)).toEqual(["取込D", "読了A"]);
  });
});

describe("buildGold 304_books", () => {
  test("year files group by finished_at ?? purchased_at; index counts and lists the unrated imported books", () => {
    const { cfg, db } = fixture();
    buildGold(cfg, db);
    const gold = (rel: string) => readFileSync(join(cfg.gold, GOLD.books, rel), "utf8");
    expect(gold("2026.md")).toContain("[読了A](../../200_silver/204_books/読了A.md) — 感想あり");
    expect(gold("2025.md")).toContain("- 2 冊");
    expect(gold("2025.md")).toContain("[取込D](../../200_silver/204_books/取込D.md) — 読み直した");
    expect(gold("2025.md")).toContain("[取込B](../../200_silver/204_books/取込B.md)\n"); // the fixed import summary is not repeated
    expect(gold("2024.md")).toContain("[取込C]");
    expect(gold("unknown.md")).toContain("- 1 冊（読了日も購入日も無い本）");
    expect(gold("unknown.md")).toContain("[日付なしE]");
    const index = gold("index.md");
    expect(index).toContain("- 読了 5 / 読書中 0 / 積読 1");
    expect(index).toContain("- 未評価の読了本（取り込み分）: 2 冊");
    expect(index).toContain("## 未評価の読了本");
    expect(index).toContain("- [取込C](../../200_silver/204_books/取込C.md) — 著者C（2024-12-31 購入）\n- [取込B](../../200_silver/204_books/取込B.md) — 著者B（2025-03-01 購入）");
    expect(index).not.toContain("…他");
    expect(index).toContain("| [読了A](../../200_silver/204_books/読了A.md) |  |  | ★★★★☆ | 2026-10-02 |  |");
    expect(index).toContain("| [取込B](../../200_silver/204_books/取込B.md) | 著者B |  |  |  | 2025-03-01 |");
  });
});

describe("importKoboLibrary", () => {
  test("parses the export, skips titles that already have a note, creates the rest with the import fields, marks processed", () => {
    const { cfg, db, reg } = fixture();
    const rows = parseKoboCsv(readFileSync(join(cfg.root, "100_bronze/2026/10/20261013-file-abcdef/kobo.csv"), "utf8"));
    expect(rows.map((r) => [r.title, r.isbn, r.addedAt])).toEqual([["取込B", "", "2025-03-01"], ["新刊G", "9784000000001", "2026-10-05"], ["新刊, H", "9784000000002", "2026-10-06"], ["新刊, H", "9784000000002", "2026-10-06"]]);
    const r = importKoboLibrary(cfg, reg, db, "20261013-file-abcdef", { status: "read" });
    expect(r.skipped).toEqual([{ title: "取込B", path: "200_silver/204_books/取込B.md" }]);
    expect(r.created.map((c) => c.title)).toEqual(["新刊G", "新刊, H"]);
    const g = parseNote(readFileSync(join(cfg.root, r.created[0].path), "utf8"));
    expect(g.fm).toMatchObject({ type: "book", title: "新刊G", status: "read", author: "著者G", publisher: "社G", platform: "kobo", purchased_at: "2026-10-05", imported: true, isbn: "9784000000001", summary: IMPORTED_SUMMARY, sources: ["20261013-file-abcdef"] });
    expect(reg.validate(g.fm)).toEqual([]);
    expect(g.body).toContain("## 概要（ネタバレなし）\n\n- 商品ページ: https://books.example/p2\n");
    expect(readMeta(cfg, "20261013-file-abcdef")?.processed_to).toEqual(r.created.map((c) => c.path));
    // a second run (same export, now indexed) creates nothing
    indexNotes(cfg, db);
    const again = importKoboLibrary(cfg, reg, db, "20261013-file-abcdef");
    expect(again.created).toEqual([]);
    expect(again.skipped.length).toBe(3);
    expect(existsSync(join(cfg.root, "200_silver/204_books/新刊G.md"))).toBe(true);
  });
  test("refuses a Bronze item without a CSV or with another CSV layout", () => {
    const { cfg, db, reg } = fixture();
    expect(() => importKoboLibrary(cfg, reg, db, "20261013-file-nonono")).toThrow("not a CSV");
    expect(() => parseKoboCsv("a,b,c\n1,2,3\n")).toThrow("not a Kobo library export");
  });
});
