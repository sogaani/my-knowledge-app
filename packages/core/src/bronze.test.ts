import { describe, expect, test } from "bun:test";
import { guessKind } from "./bronze";

describe("guessKind", () => {
  test("mail by extension", () => {
    expect(guessKind("/x/receipt.eml")).toBe("mail");
  });
  test("Gmail pushes rendered as Markdown are mail", () => {
    expect(guessKind("/inbox/mail-20261011-purchase-1a128c78f545592e.md")).toBe("mail");
  });
  test("other markdown stays a note", () => {
    expect(guessKind("/inbox/moneytree-2026-10-01_2026-10-07.md")).toBe("note");
    expect(guessKind("/inbox/memo.md")).toBe("note");
  });
});

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile } from "./bronze";

describe("ingestFile", () => {
  test("re-ingesting identical content the same day removes the inbox copy", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-bronze-"));
    const cfg = { root, bronze: join(root, "10_bronze") } as unknown as Parameters<typeof ingestFile>[0];
    const a = join(root, "a.md"); writeFileSync(a, "same content");
    const first = ingestFile(cfg, a);
    expect(existsSync(a)).toBe(false);
    const b = join(root, "a.md"); writeFileSync(b, "same content");
    const second = ingestFile(cfg, b);
    expect(second.id).toBe(first.id);
    expect(existsSync(b)).toBe(false);
  });
});
