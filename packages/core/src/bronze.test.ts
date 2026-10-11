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
