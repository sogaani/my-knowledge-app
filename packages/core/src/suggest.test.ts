import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLD, loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { parseNote } from "./frontmatter";
import { buildGold } from "./build";
import { validateAll } from "./maintain";
import { SchemaRegistry } from "./schema";
import { currentRecommendation, noteFieldsFor, parseSuggestions, reactToSuggestion, relLink, suggestionCounts, suggestionIds } from "./suggest";

const LIST = `# おすすめ 2026-10-12

## 本
- [x] **封鎖館** — 著者A / mystery / 本格 — 閉ざされた館の本格 <!-- id: book-fuusakan, reaction: read -->
- [ ] **方舟** — 著者B / mystery / 本格 — 地下建築のクローズドサークル <!-- id: book-hakobune -->
- [ ] **近畿** — 著者C / horror / モキュメンタリー — 資料の断片で恐怖を組み立てる <!-- id: book-kinki -->

## 映画・ドラマ
- [ ] **ズーム** — 映画 / ホラー — ビデオ通話で起きる怪異 <!-- id: media-zoom -->
- [ ] **クラブ** — drama / horror — Netflix <!-- id: media-club, reaction: dismissed -->

## 記事
- [ ] [特集](https://example.com/a) — 配信ラインナップ <!-- id: article-tokushu -->
- [ ] [id なし](https://example.com/b) — 表示されない
`;

/** A throwaway data repo with book / media / recommendation schemas and templates (fixture only). */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kb-suggest-"));
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const note = (rel: string, fm: Record<string, unknown>, body = "") =>
    w(rel, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}`);
  const schema = (type: string, folder: string, props: Record<string, unknown> = {}) => w(`900_system/schemas/${type}.json`, JSON.stringify({
    $id: `kb:${type}`, "x-kb": { folder, entity: "file" }, allOf: [{ $ref: "kb:common" }], properties: { type: { const: type }, ...props },
  }));
  w("900_system/schemas/_common.json", JSON.stringify({
    $id: "kb:common", type: "object", required: ["type", "title", "status", "created", "updated"],
    properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, sources: { type: "array", items: { type: "string" } }, related: { type: "array", items: { type: "string" } } },
  }));
  schema("book", "200_silver/204_books", { subgenre: { enum: ["本格", "モキュメンタリー", ""] } });
  schema("media", "200_silver/205_media", { kind: { enum: ["movie", "drama"] } });
  schema("recommendation", "200_silver/208_reviews", { status: { enum: ["open", "closed"] }, date: { type: "string" } });
  const tpl = (type: string, extra: string) => w(`800_templates/${type}.md`, `---\ntype: ${type}\ntitle: "{{title}}"\nstatus: want\ntags: []\ncreated: {{today}}\nupdated: {{today}}\nsources: []\nrelated: []\nsummary: ""\n${extra}---\n\n# {{title}}\n`);
  tpl("book", 'author: ""\ngenre: ""\nsubgenre: ""\n');
  tpl("media", 'kind: movie\nplatform: ""\n');
  w("AGENTS.md", "");
  const base = { created: "2026-10-12", updated: "2026-10-12", summary: "s" };
  note("200_silver/208_reviews/おすすめ-2026-10-05.md", { ...base, type: "recommendation", title: "おすすめ 2026-10-05", status: "closed", date: "2026-10-05", superseded_by: "./おすすめ-2026-10-12.md" }, "\n## 本\n- [x] **旧作** — 著者Z / mystery — 古い提案 <!-- id: book-old, reaction: dismissed -->\n");
  note("200_silver/208_reviews/おすすめ-2026-10-12.md", { ...base, type: "recommendation", title: "おすすめ 2026-10-12", status: "open", date: "2026-10-12", summary: "本格ミステリ中心" }, "\n" + LIST.replace(/^# .*\n/, ""));
  // made from the read suggestion: sources names its id
  note("200_silver/204_books/封鎖館.md", { ...base, type: "book", title: "封鎖館", status: "want", sources: ["suggestion:book-fuusakan"], related: ["../208_reviews/おすすめ-2026-10-12.md"] });
  note("200_silver/204_books/謎.md", { ...base, type: "book", title: "謎", status: "want", sources: ["suggestion:book-nonexistent"] });
  return root;
}

function open(root: string) {
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  const db = openDb(cfg);
  indexNotes(cfg, db);
  return { cfg, db, reg: new SchemaRegistry(cfg) };
}

describe("parseSuggestions", () => {
  test("reads title, meta fields, reason, reaction and url per section; lines without an id are skipped", () => {
    const items = parseSuggestions(LIST);
    expect(items.map((i) => i.id)).toEqual(["book-fuusakan", "book-hakobune", "book-kinki", "media-zoom", "media-club", "article-tokushu"]);
    expect(items[0]).toMatchObject({ kind: "book", section: "本", title: "封鎖館", meta: ["著者A", "mystery", "本格"], reason: "閉ざされた館の本格", reaction: "read" });
    expect(items[3]).toMatchObject({ kind: "media", title: "ズーム", meta: ["映画", "ホラー"], reaction: undefined });
    expect(items[5]).toMatchObject({ kind: "article", title: "特集", url: "https://example.com/a", meta: [], reason: "配信ラインナップ" });
    expect(suggestionCounts(items)).toEqual([
      { section: "本", total: 3, read: 1, dismissed: 0, open: 2 },
      { section: "映画・ドラマ", total: 2, read: 0, dismissed: 1, open: 1 },
      { section: "記事", total: 1, read: 0, dismissed: 0, open: 1 },
    ]);
  });
  test("relLink writes note-relative paths the way related: does", () => {
    expect(relLink("200_silver/204_books/x.md", "200_silver/208_reviews/おすすめ.md")).toBe("../208_reviews/おすすめ.md");
    expect(relLink("200_silver/208_reviews/a.md", "200_silver/208_reviews/b.md")).toBe("./b.md");
    expect(relLink("200_silver/206_projects/_archive/p/README.md", "200_silver/206_projects/q/README.md")).toBe("../../q/README.md");
  });
});

describe("noteFieldsFor", () => {
  test("book: author / genre / subgenre (only enum values), media: kind; both get the reason, the suggestion source and the backlink", () => {
    const { reg } = open(fixtureRoot());
    const [fuusakan, , kinki, zoom, club] = parseSuggestions(LIST);
    const rec = "200_silver/208_reviews/おすすめ-2026-10-12.md";
    expect(noteFieldsFor(reg, fuusakan!, rec)).toEqual({ status: "want", summary: "閉ざされた館の本格", sources: ["suggestion:book-fuusakan"], related: ["../208_reviews/おすすめ-2026-10-12.md"], author: "著者A", genre: "mystery", subgenre: "本格" });
    expect(noteFieldsFor(reg, { ...kinki!, meta: ["著者C", "horror", "怪談風"] }, rec)).not.toHaveProperty("subgenre");
    expect(noteFieldsFor(reg, zoom!, rec)).toMatchObject({ kind: "movie" });
    expect(noteFieldsFor(reg, club!, rec)).toMatchObject({ kind: "drama" });
  });
});

describe("reactToSuggestion", () => {
  test("marks the line in the open recommendation note and creates the book with the line's fields", () => {
    const root = fixtureRoot();
    const { cfg, db, reg } = open(root);
    expect(currentRecommendation(db)?.path).toBe("200_silver/208_reviews/おすすめ-2026-10-12.md");
    const r = reactToSuggestion(cfg, reg, db, { id: "book-hakobune", reaction: "read" });
    expect(r.created).toBe("200_silver/204_books/方舟.md");
    const book = parseNote(readFileSync(join(root, r.created!), "utf8")).fm;
    expect(book).toMatchObject({ status: "want", author: "著者B", genre: "mystery", subgenre: "本格", sources: ["suggestion:book-hakobune"], related: ["../208_reviews/おすすめ-2026-10-12.md"], summary: "地下建築のクローズドサークル" });
    const list = readFileSync(join(root, r.path), "utf8");
    expect(list).toContain("- [x] **方舟** — 著者B / mystery / 本格 — 地下建築のクローズドサークル <!-- id: book-hakobune, reaction: read -->");
    expect(list).toContain("<!-- id: book-kinki -->"); // untouched
  });
  test("dismissed and articles create nothing; a duplicate title reports the existing note; unknown ids throw", () => {
    const root = fixtureRoot();
    const { cfg, db, reg } = open(root);
    expect(reactToSuggestion(cfg, reg, db, { id: "book-kinki", reaction: "dismissed" }).created).toBeNull();
    expect(readFileSync(join(root, "200_silver/208_reviews/おすすめ-2026-10-12.md"), "utf8")).toContain("<!-- id: book-kinki, reaction: dismissed -->");
    expect(reactToSuggestion(cfg, reg, db, { id: "article-tokushu", reaction: "read" }).created).toBeNull();
    indexNotes(cfg, db);
    const dup = reactToSuggestion(cfg, reg, db, { id: "book-fuusakan", reaction: "read" });
    expect(dup.created).toBeNull();
    expect(dup.existing).toBe("200_silver/204_books/封鎖館.md");
    expect(() => reactToSuggestion(cfg, reg, db, { id: "book-old", reaction: "read" })).toThrow(/not found/);
  });
});

describe("validateAll with suggestion sources", () => {
  test("accepts suggestion:<id> when the id is in some recommendation note (archived too), errors otherwise", () => {
    const cfg = loadConfig(fixtureRoot());
    expect([...suggestionIds(cfg)].sort()).toEqual(["article-tokushu", "book-fuusakan", "book-hakobune", "book-kinki", "book-old", "media-club", "media-zoom"]);
    const errors = validateAll(cfg, new SchemaRegistry(cfg)).filter((i) => i.level === "error");
    expect(errors).toEqual([{ level: "error", path: "200_silver/204_books/謎.md", msg: "sources entry names an unknown suggestion id: suggestion:book-nonexistent" }]);
  });
});

describe("buildGold 307", () => {
  test("links the open recommendation note with its counts and lists earlier ones; the list itself is not copied", () => {
    const { cfg, db } = open(fixtureRoot());
    buildGold(cfg, db);
    const gold = readFileSync(join(cfg.gold, GOLD.suggestions), "utf8");
    expect(gold).toContain("## 最新: [おすすめ 2026-10-12](../200_silver/208_reviews/おすすめ-2026-10-12.md)（2026-10-12）");
    expect(gold).toContain("本格ミステリ中心");
    expect(gold).toContain("| 本 | 3 | 1 | 0 | 2 |");
    expect(gold).toContain("| 映画・ドラマ | 2 | 0 | 1 | 1 |");
    expect(gold).toContain("- [おすすめ 2026-10-05](../200_silver/208_reviews/おすすめ-2026-10-05.md)（2026-10-05、closed）");
    expect(gold).not.toContain("<!-- id:");
  });
  test("without any recommendation note the page says so", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "200_silver/208_reviews/おすすめ-2026-10-12.md"), "no frontmatter");
    writeFileSync(join(root, "200_silver/208_reviews/おすすめ-2026-10-05.md"), "no frontmatter");
    const { cfg, db } = open(root);
    buildGold(cfg, db);
    expect(readFileSync(join(cfg.gold, GOLD.suggestions), "utf8")).toContain("まだ提案がありません");
  });
});
