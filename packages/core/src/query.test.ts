import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { queryTerms, runQuery } from "./query";
import { bodyExcerpt, keywordSearch } from "./search";

describe("queryTerms", () => {
  test("splits by character class and drops hiragana particles and 1-char runs", () => {
    expect(queryTerms("孤島が舞台のミステリー")).toEqual(["孤島", "舞台", "ミステリ"]);
    expect(queryTerms("原油高で恩恵を受ける銘柄")).toEqual(["原油高", "恩恵", "銘柄"]);
    expect(queryTerms("孤島 ミステリー")).toEqual(["孤島", "ミステリ"]);
    expect(queryTerms("サーバー コーヒー ラー")).toEqual(["サーバ", "コーヒ", "ラー"]); // trailing ー kept when the word would get too short
    expect(queryTerms("ドラム式洗濯機を買いたい")).toEqual(["ドラム", "式洗濯機"]);
  });
  test("keeps alphanumerics together, folds width, dedups", () => {
    expect(queryTerms("Cloudflare Durable Objects")).toEqual(["Cloudflare", "Durable", "Objects"]);
    expect(queryTerms("bge-m3の5G対応")).toEqual(["bge-m3", "5G", "対応"]);
    expect(queryTerms("ＫＤＤＩ KDDI")).toEqual(["KDDI"]);
  });
  test("hiragana-only pieces survive; empty input yields nothing; odd input falls back to whitespace pieces", () => {
    expect(queryTerms("おすすめ ミステリー")).toEqual(["おすすめ", "ミステリ"]);
    expect(queryTerms("   ")).toEqual([]);
    expect(queryTerms("受ける")).toEqual(["受ける"]);
  });
});

describe("runQuery text search (SQLite fallback path)", () => {
  let db: Database;
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "kb-query-"));
    const w = (name: string, fm: Record<string, unknown>, body: string) => {
      const p = join(root, "200_silver/204_books", `${name}.md`);
      mkdirSync(join(p, ".."), { recursive: true });
      const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`).join("\n");
      writeFileSync(p, `---\n${yaml}\n---\n\n${body}\n`);
    };
    w("island", { type: "book", title: "嵐の島の殺人", status: "done", tags: ["mystery"], summary: "孤島に集まった十人が一人ずつ消えていく本格ミステリ", updated: "2026-09-01" },
      "# 嵐の島の殺人\n\n## 感想\n\n嵐で閉ざされた孤島という舞台装置が効いている。\n\n> [!spoiler]\n> 犯人は執事の兄だった。\n\n## メモ\n\n読了。");
    w("space", { type: "book", title: "宇宙ミステリー入門", status: "todo", tags: [], summary: "宇宙ステーションで起きる事件", updated: "2026-09-02" },
      "# 宇宙ミステリー入門\n\n## 概要\n\n宇宙を舞台にした短編集。");
    w("city", { type: "book", title: "都市の夜", status: "todo", tags: ["novel"], summary: "街を歩く話", updated: "2026-09-03" },
      "# 都市の夜\n\n## 概要\n\n本文の終わりのほうでだけミステリーという言葉が出てくる。");
    w("cooking", { type: "book", title: "家庭料理の基本", status: "done", tags: ["cooking"], summary: "毎日の献立", updated: "2026-09-04" },
      "# 家庭料理の基本\n\n## 概要\n\n煮物と焼き物。孤島とは無関係。");
    const cfg = loadConfig(root);
    db = openDb(cfg);
    indexNotes(cfg, db);
  });
  const paths = (text: string, extra: Partial<Parameters<typeof runQuery>[1]> = {}) =>
    runQuery(db, { filters: [], text, ...extra }).map((r) => r.path.replace(/^.*\//, "").replace(/\.md$/, ""));

  test("a natural-language query matches on its content words", () => {
    expect(paths("孤島が舞台のミステリー")).toEqual(["island"]);
    expect(paths("孤島 ミステリー")).toEqual(["island"]);
  });
  test("AND first; OR fallback when no note has every term, best coverage first", () => {
    expect(paths("宇宙 ミステリー")).toEqual(["space"]);
    // nothing has 宇宙 and 孤島 together → every note with either, 2-term coverage impossible so ranked by score
    const or = paths("宇宙 孤島 殺人");
    expect(or[0]).toBe("island"); // 孤島 + 殺人
    expect(or).toContain("space");
    expect(or).toContain("cooking");
    expect(or).not.toContain("city");
    expect(paths("存在しない語")).toEqual([]);
  });
  test("title and summary outrank body, for trigram (>= 3 chars) and LIKE (short) terms alike", () => {
    expect(paths("ミステリー")).toEqual(["space", "island", "city"]); // title > summary > body
    expect(paths("孤島")).toEqual(["island", "cooking"]); // summary > body
    expect(paths("殺人")[0]).toBe("island");
  });
  test("filters and explicit order still apply", () => {
    expect(paths("ミステリー", { filters: [{ field: "status", op: "=", value: "done" }] })).toEqual(["island"]);
    expect(paths("ミステリー", { orderBy: "-updated" })).toEqual(["city", "space", "island"]);
    expect(paths("ミステリー", { limit: 1 })).toEqual(["space"]);
  });
  test("keywordSearch shows the section and text around the first hit, without spoilers", () => {
    const [hit] = keywordSearch(db, "孤島が舞台のミステリー", [], {});
    expect(hit.path.endsWith("island.md")).toBe(true);
    expect(hit.matches[0].heading).toBe("感想");
    expect(hit.matches[0].snippet).toContain("孤島という舞台装置");
    expect(hit.matches[0].snippet).not.toContain("執事");
    // terms only in metadata (the H1 title line does not count) → summary
    const [space] = keywordSearch(db, "ステーション 入門", [], {});
    expect(space.matches[0].snippet).toBe("宇宙ステーションで起きる事件");
    expect(space.matches[0].heading).toBe("");
    // spoilers opt-in
    const [sp] = keywordSearch(db, "執事", [], { spoilers: true });
    expect(sp.matches[0].snippet).toContain("執事");
    expect(keywordSearch(db, "執事", [], {})[0].matches[0].snippet).not.toContain("執事");
  });
  test("bodyExcerpt windows around the first term", () => {
    const ex = bodyExcerpt("## A\n\n" + "x".repeat(300) + "\n\n## B\n\n" + "y".repeat(200) + "ラーメン" + "z".repeat(300), "ラーメン", 60);
    expect(ex?.heading).toBe("B");
    expect(ex?.snippet).toMatch(/^…y+ラーメンz+…$/);
    expect(bodyExcerpt("nothing here", "ラーメン")).toBeNull();
  });
});
