import { describe, expect, test } from "bun:test";
import { chunkNote, dropLeadingTitle, noteHash, splitLong, stripUrls } from "./chunk";
import type { Note } from "./notes";

const note = (body: string, fm: Record<string, unknown> = {}): Note => ({
  path: "200_silver/204_books/十角館の殺人.md", absPath: "", type: "book", title: "十角館の殺人", status: "done", summary: "孤島の館で起きる連続殺人",
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
    expect(h.embedText).toBe(`# ${h.text}`);
    expect(h.thin).toBe(true);
  });

  test("thin only when the body (and attachments) yield no chunk", () => {
    expect(chunkNote(note("# 十角館の殺人\n")).map((c) => c.thin)).toEqual([true]);
    expect(chunkNote(note("本文")).map((c) => c.thin)).toEqual([false, false]);
    expect(chunkNote(note(""), [{ path: "200_silver/206_projects/x/log.md", body: "## 2026-10-09\n\n開始した。" }]).map((c) => c.thin)).toEqual([false, false]);
  });

  test("the leading H1 that repeats the title is not a chunk; other H1 lines stay", () => {
    const cs = chunkNote(note("# 十角館の殺人\n\n## 感想\n\n面白かった。"));
    expect(cs.map((c) => c.heading)).toEqual(["", "感想"]);
    expect(cs.some((c) => c.text === "# 十角館の殺人")).toBe(false);
    expect(chunkNote(note("# 別の見出し\n\n本文"))[1].text).toBe("# 別の見出し\n\n本文");
    expect(dropLeadingTitle("# 2026-10 予定\n\n本文", "2026-10")).toBe("本文");
    expect(dropLeadingTitle("# 2026-10", "2026-10")).toBe("");
  });

  test("URLs are stripped from text and embedText, link text survives", () => {
    const cs = chunkNote(note("## リンク\n\n[公式サイト](https://example.com/a?b=c) と <https://example.com/x> と https://example.com/y。\n\n![図](https://example.com/i.png)\n\nhttps://example.com/only-url\n\n次の段落。"));
    const c = cs.find((x) => x.heading === "リンク")!;
    expect(c.text).toBe("公式サイト と  と 。\n\n図\n\n次の段落。");
    expect(c.text).not.toContain("http");
    expect(c.embedText).not.toContain("http");
    expect(stripUrls("plain text")).toBe("plain text");
    expect(stripUrls("[a](<https://e.com/x y>) [b](https://e.com/w(1)) [c](https://e.com \"t\")")).toBe("a b c");
  });

  test("header chunk strips URLs from frontmatter values", () => {
    const [h] = chunkNote(note("", { url: "https://example.com/book", isbn: "123" }));
    expect(h.text).not.toContain("http");
    expect(h.text).toContain("isbn: 123");
  });

  test("one chunk per H2 section, with context header in embedText", () => {
    const cs = chunkNote(note("前置き。\n\n## 感想\n\n面白かった。\n\n## メモ\n\n再読したい。"));
    expect(cs.map((c) => c.heading)).toEqual(["", "", "感想", "メモ"]);
    expect(cs[2].text).toBe("面白かった。");
    expect(cs[2].embedText).toBe("# 十角館の殺人\ntags: mystery, closed-circle\n## 感想\n面白かった。");
    expect(cs[2].embedText).not.toContain("孤島の館"); // summary lives only in the header chunk
    expect(cs[0].embedText).toContain("孤島の館で起きる連続殺人");
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

  test("an empty spoiler callout (template placeholder) is no chunk, so the note is thin", () => {
    const cs = chunkNote(note("# 十角館の殺人\n\n> [!spoiler]- ネタバレ\n"));
    expect(cs).toHaveLength(1);
    expect(cs[0].thin).toBe(true);
    const cs2 = chunkNote(note("> [!spoiler]- ネタバレ\n>\n> 犯人は守須。"));
    expect(cs2.map((c) => c.spoiler)).toEqual([false, true]);
  });

  test("attachments drop their own `# title — …` line", () => {
    const cs = chunkNote(note("本文"), [{ path: "200_silver/206_projects/十角館の殺人/log.md", body: "# 十角館の殺人 — ログ\n\n- 開始" }]);
    expect(cs.find((c) => c.path.endsWith("log.md"))!.text).toBe("- 開始");
  });

  test("URLs are removed before long paragraphs are hard-split", () => {
    const row = "| 2026-10-01 | [店](https://maps.example.com/?cid=1234567890&g_mp=abcdefghijklmnopqrstuvwxyz) |";
    const cs = chunkNote(note("## 表\n\n" + Array(40).fill(row).join("\n")), [], { maxChars: 300, overlap: 30 });
    expect(cs.length).toBeGreaterThan(2);
    for (const c of cs) { expect(c.text).not.toMatch(/maps\.example|cid=/); }
  });

  test("attachments are chunked under the note with a prefixed heading", () => {
    const cs = chunkNote(note("本文"), [{ path: "200_silver/206_projects/2026-10_x/log.md", body: "## 2026-10-09\n\n開始した。" }]);
    const att = cs.find((c) => c.path.endsWith("log.md"))!;
    expect(att.heading).toBe("log / 2026-10-09");
    expect(att.notePath).toBe("200_silver/204_books/十角館の殺人.md");
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
