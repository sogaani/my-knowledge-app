import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFileName, captureKey, contentHash, itemOutcomes, parseCapture, renderCaptureFile } from "./capture";
import { ingestFile, markProcessed } from "./bronze";
import { loadConfig } from "./config";
import { parseNote } from "./frontmatter";

describe("parseCapture", () => {
  test("accepts a conversation and fills the title from the body", () => {
    const r = parseCapture({ client: "chrome", platform: "gemini", conversation_id: "abc123", markdown: "## 量子コンピュータの現状\n本文", area: "" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.title).toBe("量子コンピュータの現状"); expect(r.value.area).toBeUndefined(); }
  });
  test("rejects unknown clients / platforms, empty bodies and non-http urls", () => {
    expect(parseCapture({ client: "x", platform: "gemini", markdown: "a" }).ok).toBe(false);
    expect(parseCapture({ client: "chrome", platform: "bard", markdown: "a" }).ok).toBe(false);
    expect(parseCapture({ client: "share", platform: "web", markdown: " " }).ok).toBe(false);
    expect(parseCapture({ client: "share", platform: "web", markdown: "", url: "javascript:alert(1)" }).ok).toBe(false);
    expect(parseCapture({ client: "share", platform: "web", markdown: "", url: "https://g.co/gemini/share/x" }).ok).toBe(true);
    expect(parseCapture({ client: "chrome", platform: "claude", markdown: "a", area: "office" }).ok).toBe(false);
  });
});

describe("capture identity", () => {
  test("the conversation id is the key; the content hash changes with the body", () => {
    const a = { platform: "claude" as const, conversation_id: "c-1", markdown: "v1" };
    expect(captureKey(a)).toBe("claude:c-1");
    expect(captureKey({ ...a, markdown: "v2" })).toBe("claude:c-1");
    expect(contentHash(a)).not.toBe(contentHash({ ...a, markdown: "v2" }));
    // no id: the url, else the body
    expect(captureKey({ platform: "web", url: "https://x.test/a", markdown: "" })).toMatch(/^web:url:[0-9a-f]{16}$/);
    expect(captureKey({ platform: "claude-code", markdown: "x" })).toMatch(/^claude-code:body:/);
  });
  test("file names are inbox-safe", () => {
    const n = captureFileName("gemini:c/../../etc 1", "abcdef0123456789");
    expect(n).toBe("capture-gemini-cetc1-abcdef01.md");
    expect(captureFileName("web:url:0123456789abcdef", "ff00ff00aa")).toBe("capture-web-0123456789abcdef-ff00ff00.md");
  });
  test("the inbox file carries the routing fields and the previous notes", () => {
    const text = renderCaptureFile(
      { client: "chrome", platform: "gemini", title: "t: x", markdown: "# t\nbody", area: "work", url: "https://gemini.google.com/app/1" },
      { capture_id: "id1", key: "gemini:1", version: 2, hash: "h", previous_notes: ["200_silver/201_learning/a.md"] },
    );
    const { fm, body } = parseNote(text);
    expect(fm).toMatchObject({ capture_id: "id1", capture_key: "gemini:1", version: 2, platform: "gemini", area: "work", title: "t: x", previous_notes: ["200_silver/201_learning/a.md"] });
    expect(fm.note).toBeUndefined();
    expect(body.trim()).toBe("# t\nbody");
  });
});

describe("itemOutcomes", () => {
  test("maps inbox names to their Bronze item and notes", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-capture-"));
    const cfg = loadConfig(root);
    const src = join(root, "capture-gemini-1-aa.md");
    writeFileSync(src, "---\ncapture_id: x\n---\nhello");
    const meta = ingestFile(cfg, src);
    markProcessed(cfg, meta.id, ["200_silver/201_learning/q.md", "-"]);
    const src2 = join(root, "capture-claude-2-bb.md");
    writeFileSync(src2, "other");
    const m2 = ingestFile(cfg, src2);
    const out = itemOutcomes(cfg, ["capture-gemini-1-aa.md", "capture-claude-2-bb.md", "missing.md"]);
    expect(out).toEqual([
      { name: "capture-gemini-1-aa.md", bronze: meta.id, notes: ["200_silver/201_learning/q.md"], processed: true },
      { name: "capture-claude-2-bb.md", bronze: m2.id, notes: [], processed: false },
      { name: "missing.md", bronze: null, notes: [], processed: false },
    ]);
  });
});
