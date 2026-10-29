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
    const cfg = { root, bronze: join(root, "100_bronze") } as unknown as Parameters<typeof ingestFile>[0];
    const a = join(root, "a.md"); writeFileSync(a, "same content");
    const first = ingestFile(cfg, a);
    expect(existsSync(a)).toBe(false);
    const b = join(root, "a.md"); writeFileSync(b, "same content");
    const second = ingestFile(cfg, b);
    expect(second.id).toBe(first.id);
    expect(existsSync(b)).toBe(false);
  });
});

describe("kb inbox put", () => {
  const { putInbox, listInbox } = require("./bronze") as typeof import("./bronze");
  const { loadConfig } = require("./config") as typeof import("./config");
  const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  test("writes atomically by name, refuses an existing name unless forced, rejects paths", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-inbox-"));
    writeFileSync(join(root, "AGENTS.md"), "");
    const cfg = loadConfig(root);
    expect(putInbox(cfg, "moneytree-2026-10-22_2026-10-29.md", "# a\n")).toBe(true);
    expect(readFileSync(join(cfg.inbox, "moneytree-2026-10-22_2026-10-29.md"), "utf8")).toBe("# a\n");
    expect(existsSync(join(cfg.inbox, "moneytree-2026-10-22_2026-10-29.md.part"))).toBe(false);
    expect(putInbox(cfg, "moneytree-2026-10-22_2026-10-29.md", "# b\n")).toBe(false);
    expect(readFileSync(join(cfg.inbox, "moneytree-2026-10-22_2026-10-29.md"), "utf8")).toBe("# a\n");
    expect(putInbox(cfg, "moneytree-2026-10-22_2026-10-29.md", "# b\n", { force: true })).toBe(true);
    expect(readFileSync(join(cfg.inbox, "moneytree-2026-10-22_2026-10-29.md"), "utf8")).toBe("# b\n");
    expect(listInbox(cfg).map((p) => p.split("/").pop())).toEqual(["moneytree-2026-10-22_2026-10-29.md"]);
    for (const bad of ["", "../x.md", "a/b.md", ".hidden", " x.md"]) expect(() => putInbox(cfg, bad, "x")).toThrow(/bad inbox name/);
  });
});
