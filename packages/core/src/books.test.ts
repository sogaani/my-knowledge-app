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
import { IMPORTED_SUMMARY, STORYGRAPH_SUMMARY, bookYear, importKoboLibrary, importStoryGraphLibrary, isKoboCsv, isStoryGraphCsv, isbn13, parseDatesRead, parseImportedSummary, parseKoboCsv, parseStoryGraphCsv, unratedImported } from "./books";

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
  note("200_silver/204_books/読中S.md", { ...base, title: "読中S", status: "reading", summary: STORYGRAPH_SUMMARY, imported: true, started_at: "2026-10-20" });
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
    expect(titles(["imported=true"])).toEqual(["取込B", "取込C", "取込D", "積読F", "読中S"]);
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
    expect(index).toContain("- 読了 5 / 読書中 1 / 積読 1");
    expect(index).toContain("## 読書中\n- [読中S](../../200_silver/204_books/読中S.md)（2026-10-20 から）\n");
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

const SG_HEADER = "Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?";
const SG_CSV = [
  SG_HEADER,
  // already read in 204_books with the same date and a 4: nothing to change (4.25 rounds to 4)
  '読了A,著者A,"",9784000000011,digital,read,2026/09/01,2026/10/02,2026/09/20-2026/10/02,1,"",,,,,,,4.25,"","",,"",No',
  // on the shelf as want: now being read since 10/20
  '積読F,著者F,"",,,currently-reading,2026/10/19,"",2026/10/20-,0,"",,,,,,,,,"",,"",No',
  // read in 204_books but back on StoryGraph as to-read: left alone
  '取込D,著者D,"",,,to-read,2026/10/25,"","",0,"",,,,,,,,,"",,"",No',
  // new: ISBN-10, paperback, two reads, a multi-line review, 3.75 stars, tags
  '新刊Z,著者Z,"訳者Z (Translator)",4062766450,paperback,read,2026/10/01,2026/10/28,"2025/01/02-2025/01/10, 2026/10/21-2026/10/28",2,"dark, tense",fast,,,,,,3.75,"一気読み。\n""二度目""も良い。","",,"mystery, 再読",Yes',
  // new: did not finish, audio, no dates
  '途中Y,著者Y,"",,audio,did-not-finish,2026/10/02,"","",0,"",,,,,,,,,"",,"",No',
].join("\n");

describe("StoryGraph export", () => {
  test("header detection, dates read, ISBN-10 → 13", () => {
    expect(isStoryGraphCsv(SG_CSV)).toBe(true);
    expect(isStoryGraphCsv("\uFEFF" + SG_CSV)).toBe(true);
    expect(isKoboCsv(SG_CSV)).toBe(false);
    expect(isKoboCsv('"productId","isbn","title"\n')).toBe(true);
    expect(parseDatesRead("2026/09/20-2026/10/02", "2026/10/02")).toEqual({ startedAt: "2026-09-20", finishedAt: "2026-10-02" });
    expect(parseDatesRead("2025/01/02-2025/01/10, 2026/10/21-2026/10/28", "")).toEqual({ startedAt: "2026-10-21", finishedAt: "2026-10-28" });
    expect(parseDatesRead("2026/10/20-", "")).toEqual({ startedAt: "2026-10-20", finishedAt: "" });
    expect(parseDatesRead("-2026/10/20", "")).toEqual({ startedAt: "", finishedAt: "2026-10-20" });
    expect(parseDatesRead("", "2026/10/02")).toEqual({ startedAt: "", finishedAt: "2026-10-02" });
    expect(isbn13("4062766450")).toBe("9784062766456");
    expect(isbn13("9784062766456")).toBe("9784062766456");
    expect(isbn13("7275000572538")).toBe("7275000572538");
    expect(() => parseStoryGraphCsv("productId,isbn\n")).toThrow(/not a StoryGraph/);
  });

  test("rows: status map, rounded stars, review with newlines and doubled quotes, tags", () => {
    const rows = parseStoryGraphCsv(SG_CSV);
    expect(rows.map((r) => [r.title, r.status, r.readStatus, r.startedAt, r.finishedAt, r.rating, r.readCount])).toEqual([
      ["読了A", "read", "read", "2026-09-20", "2026-10-02", 4, 1],
      ["積読F", "reading", "currently-reading", "2026-10-20", "", 0, 0],
      ["取込D", "want", "to-read", "", "", 0, 0],
      ["新刊Z", "read", "read", "2026-10-21", "2026-10-28", 4, 2],
      ["途中Y", "dnf", "did-not-finish", "", "", 0, 0],
    ]);
    expect(rows[3]).toMatchObject({ author: "著者Z", isbn: "4062766450", format: "paperback", review: '一気読み。\n"二度目"も良い。', tags: ["mystery", "再読"] });
  });

  test("import upserts: unchanged / updated / kept / created, review into an empty 感想, processed marked", () => {
    const { cfg, db, reg } = fixture();
    mkdirSync(join(cfg.root, "100_bronze/2026/10/20261030-file-sg0001"), { recursive: true });
    writeFileSync(join(cfg.root, "100_bronze/2026/10/20261030-file-sg0001/export.csv"), SG_CSV);
    writeFileSync(join(cfg.root, "100_bronze/2026/10/20261030-file-sg0001/meta.json"), JSON.stringify({ id: "20261030-file-sg0001", kind: "file", source: "export.csv", captured_at: "2026-10-30T00:00:00Z", sha256: "0", files: ["export.csv"], processed_to: [] }));
    const r = importStoryGraphLibrary(cfg, reg, db, "20261030-file-sg0001");
    expect(r.unchanged).toEqual([]);
    expect(r.updated).toEqual([
      { path: "200_silver/204_books/読了A.md", title: "読了A", changes: ["started_at=2026-09-20", "isbn"] }, // same status / date / rating: only what the note lacked
      { path: "200_silver/204_books/積読F.md", title: "積読F", changes: ["status=reading", "started_at=2026-10-20"] },
    ]);
    expect(parseNote(readFileSync(join(cfg.root, "200_silver/204_books/読了A.md"), "utf8")).fm).toMatchObject({ status: "read", rating: 4, finished_at: "2026-10-02", started_at: "2026-09-20", isbn: "9784000000011", summary: "感想あり" });
    expect(r.kept).toEqual([{ path: "200_silver/204_books/取込D.md", title: "取込D", readStatus: "to-read" }]);
    expect(r.created.map((c) => c.title)).toEqual(["新刊Z", "途中Y"]);
    const f = parseNote(readFileSync(join(cfg.root, "200_silver/204_books/積読F.md"), "utf8")).fm;
    expect(f).toMatchObject({ status: "reading", started_at: "2026-10-20", imported: true });
    expect(f.updated).not.toBe("2026-10-12");
    expect(parseNote(readFileSync(join(cfg.root, "200_silver/204_books/取込D.md"), "utf8")).fm.status).toBe("read");
    const z = parseNote(readFileSync(join(cfg.root, "200_silver/204_books/新刊Z.md"), "utf8"));
    expect(z.fm).toMatchObject({ status: "read", author: "著者Z", isbn: "4062766450", platform: "紙", started_at: "2026-10-21", finished_at: "2026-10-28", rating: 4, imported: true, summary: STORYGRAPH_SUMMARY, sources: ["20261030-file-sg0001"] });
    expect(z.body).toContain('## 感想（ネタバレなし）\n\n一気読み。\n"二度目"も良い。\n');
    const y = parseNote(readFileSync(join(cfg.root, "200_silver/204_books/途中Y.md"), "utf8")).fm;
    expect(y).toMatchObject({ status: "dnf", platform: "audio" });
    expect(y.started_at).toBeUndefined();
    expect(readMeta(cfg, "20261030-file-sg0001")!.processed_to.sort()).toEqual(["200_silver/204_books/新刊Z.md", "200_silver/204_books/積読F.md", "200_silver/204_books/途中Y.md", "200_silver/204_books/読了A.md"].sort());
    // second run with the same export: nothing changes, the created notes are matched by ISBN-13 / title
    indexNotes(cfg, db);
    const again = importStoryGraphLibrary(cfg, reg, db, "20261030-file-sg0001");
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.unchanged.map((u) => u.title).sort()).toEqual(["新刊Z", "積読F", "読了A", "途中Y"].sort());
  });
});
