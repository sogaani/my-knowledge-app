import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// push.ts pulls in store.ts, which opens jobs.sqlite under DATA_DIR at import time.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "kb-push-"));
let p: typeof import("./push");
beforeAll(async () => { p = await import("./push"); });

describe("askDonePush", () => {
  test("question as the title, the answer's head as the body, one tag per job", () => {
    const n = p.askDonePush("Netflix は\n いくら？", "## 月額\n\n1,490 円です。\n" + "x".repeat(300), "abcdef12-0000");
    expect(n.title).toBe("回答: Netflix は いくら？");
    expect(n.body?.startsWith("## 月額 1,490 円です。 xxx")).toBe(true);
    expect(n.body?.length).toBe(200);
    expect(n.body?.endsWith("…")).toBe(true);
    expect(n.url).toBe("/chat");
    expect(n.tag).toBe("ask-abcdef12-0000");
    expect(p.askDonePush("", "", "x").title).toBe("回答: (質問なし)");
  });
});
