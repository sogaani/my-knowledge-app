import { describe, expect, test } from "bun:test";
import { chunkNote, noteHash, splitLong } from "./chunk";
import type { Note } from "./notes";

const note = (body: string, fm: Record<string, unknown> = {}): Note => ({
  path: "20_silver/24_books/十角館の殺人.md", absPath: "", type: "book", title: "十角館の殺人", status: "done", summary: "孤島の館で起きる連続殺人",
  tags: ["mystery", "closed-circle"], fm: { type: "book", title: "十角館の殺人", author: "綾辻行人", rating: 5, sources: ["x"], ...fm }, body, archived: false, mtime: 0, attachments: [],
});

describe("chunkNote", () => {
  test("header chunk carries title, summary, tags and scalar frontmatter", () => {
    const [h] = chunkNote(note(""));
    expect(h.idx).toBe(0);
    expect(h.heading).toBe("");
    expect(h.text).toContain("十角館の殺人");
    expect(h.text).toContain("author: 綾辻行人");
    expect(h.text).toContain("rating: 5");
    expect(h.text).not.toContain("sources");
  });

  test("one chunk per H2 section, with context header in embedText", () => {
    const cs = chunkNote(note("前置き。\n\n## 感想\n\n面白かった。\n\n## メモ\n\n再読したい。"));
    expect(cs.map((c) => c.heading)).toEqual(["", "", "感想", "メモ"]);
    expect(cs[2].text).toBe("面白かった。");
    expect(cs[2].embedText.startsWith("# 十角館の殺人\n孤島の館で起きる連続殺人\ntags: mystery, closed-circle\n## 感想\n")).toBe(true);
  });

  test("spoiler callouts become their own flagged chunks", () => {
    const cs = chunkNote(note("## 感想\n\nネタバレなしの感想。\n\n> [!spoiler]- 真相\n> 犯人は守須。\n> トリックは…\n\nその後の感想。"));
    const sp = cs.filter((c) => c.spoiler);
    expect(sp).toHaveLength(1);
    expect(sp[0].text).toContain("犯人は守須");
    expect(sp[0].text).toContain("真相");
    const normal = cs.filter((c) => !c.spoiler && c.heading === "感想");
    expect(normal.map((c) => c.text)).toEqual(["ネタバレなしの感想。", "その後の感想。"]);
  });

  test("attachments are chunked under the note with a prefixed heading", () => {
    const cs = chunkNote(note("本文"), [{ path: "20_silver/26_projects/2026-10_x/log.md", body: "## 2026-10-09\n\n開始した。" }]);
    const att = cs.find((c) => c.path.endsWith("log.md"))!;
    expect(att.heading).toBe("log / 2026-10-09");
    expect(att.notePath).toBe("20_silver/24_books/十角館の殺人.md");
  });

  test("headings inside code fences are ignored", () => {
    const cs = chunkNote(note("```\n## not a heading\n```\n本文"));
    expect(cs.map((c) => c.heading)).toEqual(["", ""]);
  });
});

describe("splitLong", () => {
  test("keeps short text whole, splits on paragraphs, hard-splits oversized paragraphs with overlap", () => {
    expect(splitLong("abc", 10, 2)).toEqual(["abc"]);
    expect(splitLong("aaaa\n\nbbbb\n\ncccc", 10, 2)).toEqual(["aaaa\n\nbbbb", "cccc"]);
    const parts = splitLong("x".repeat(25), 10, 2);
    expect(parts).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxxxxxx"]);
  });
});

describe("noteHash", () => {
  test("changes with body, frontmatter and attachments", () => {
    const a = noteHash(note("a"));
    expect(noteHash(note("a"))).toBe(a);
    expect(noteHash(note("b"))).not.toBe(a);
    expect(noteHash(note("a", { rating: 4 }))).not.toBe(a);
    expect(noteHash(note("a"), [{ path: "log.md", body: "x" }])).not.toBe(a);
  });
});
