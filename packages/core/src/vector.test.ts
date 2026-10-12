/** LanceDB under Bun: create / incremental embed / FTS / vector / hybrid search, with a deterministic fake embedder. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type KbConfig } from "./config";
import { openDb, indexNotes } from "./db";
import type { Embedder, EmbedProfile } from "./embed";
import { VectorStore, embedNotes } from "./vector";
import { search, rrf, buildWhere, snippet } from "./search";
import type { ChunkRow } from "./vector";

const DIM = 16;
class FakeEmbedder implements Embedder {
  profile: EmbedProfile = { model: "fake", dim: DIM, queryPrefix: "", docPrefix: "" };
  calls = 0;
  async ping() { return { ok: true as const }; }
  async embed(texts: string[]) {
    this.calls += texts.length;
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const ch of t) v[ch.codePointAt(0)! % DIM] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

let root: string, cfg: KbConfig;
const write = (rel: string, fm: Record<string, unknown>, body: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`).join("\n");
  writeFileSync(p, `---\n${yaml}\n---\n\n${body}\n`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kb-vec-"));
  process.env.KB_FTS_TOKENIZER = "icu"; // no dictionary needed in CI
  write("200_silver/204_books/十角館の殺人.md", { type: "book", title: "十角館の殺人", status: "done", tags: ["mystery"], rating: 5, summary: "孤島の館で起きる連続殺人", updated: "2026-10-01" },
    "## 感想\n\n綾辻行人の代表作。クローズドサークルの傑作。\n\n> [!spoiler]- 真相\n> 犯人は守須。");
  write("200_silver/204_books/ラーメン本.md", { type: "book", title: "東京ラーメン百選", status: "reading", tags: ["food"], rating: 3, summary: "東京のラーメン店ガイド", updated: "2026-10-02" },
    "## メモ\n\n東京タワー近くの店が良かった。");
  write("200_silver/205_media/_archive/old.md", { type: "media", title: "古い映画", status: "done", tags: [], summary: "アーカイブ済みの映画", updated: "2020-01-01" }, "殺人事件の映画。");
  cfg = loadConfig(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("VectorStore + embedNotes", () => {
  const emb = new FakeEmbedder();

  test("full build, then incremental no-op, then change + delete", async () => {
    const db = openDb(cfg);
    indexNotes(cfg, db);
    let store = await VectorStore.open(cfg);
    expect(store.ready).toBe(false);

    const s1 = await embedNotes(cfg, store, emb, {});
    expect(s1.full).toBe(true);
    expect(s1.embedded).toBe(3);
    expect(s1.rows).toBeGreaterThanOrEqual(6);
    expect(store.meta?.tokenizer).toBe("icu");
    expect(store.meta?.dim).toBe(DIM);

    const s2 = await embedNotes(cfg, store, emb, {});
    expect(s2.embedded).toBe(0);
    expect(s2.skipped).toBe(3);

    write("200_silver/204_books/ラーメン本.md", { type: "book", title: "東京ラーメン百選", status: "done", tags: ["food"], rating: 4, summary: "東京のラーメン店ガイド", updated: "2026-10-03" }, "## メモ\n\n読了。");
    rmSync(join(root, "200_silver/205_media/_archive/old.md"));
    indexNotes(cfg, db);
    const s3 = await embedNotes(cfg, store, emb, {});
    expect(s3.embedded).toBe(1);
    expect(s3.removed).toBe(1);
    const hashes = await store.existingHashes();
    expect([...hashes.keys()].sort()).toEqual(["200_silver/204_books/ラーメン本.md", "200_silver/204_books/十角館の殺人.md"]);

    // reopen: meta persisted, FTS index present
    store = await VectorStore.open(cfg);
    expect(store.ready).toBe(true);
    expect((await store.table!.listIndices()).some((i) => i.columns.includes("text"))).toBe(true);
  });

  test("keyword (BM25 via ICU tokens), vector, hybrid, filters, spoilers", async () => {
    const db = openDb(cfg);
    const store = await VectorStore.open(cfg);

    const kw = await search(cfg, db, "殺人", { mode: "keyword" }, { store, embedder: emb });
    expect(kw.mode).toBe("keyword");
    expect(kw.degraded).toBeUndefined();
    expect(kw.hits[0].path).toBe("200_silver/204_books/十角館の殺人.md");
    expect(kw.hits[0].matches[0].via).toEqual(["keyword"]);

    // spoiler chunk text hidden by default, visible on request
    const sp = await search(cfg, db, "守須", { mode: "keyword" }, { store, embedder: emb });
    expect(sp.hits[0].matches[0].spoiler).toBe(true);
    expect(sp.hits[0].matches[0].snippet).toBe("（ネタバレ：折りたたみ）");
    const sp2 = await search(cfg, db, "守須", { mode: "keyword", spoilers: true }, { store, embedder: emb });
    expect(sp2.hits[0].matches[0].snippet).toContain("守須");

    const vec = await search(cfg, db, "東京タワー近くの店が良かった。", { mode: "vector" }, { store, embedder: emb });
    expect(vec.mode).toBe("vector");
    expect(vec.hits.length).toBeGreaterThan(0);

    const hy = await search(cfg, db, "ラーメン", { mode: "hybrid" }, { store, embedder: emb });
    expect(hy.mode).toBe("hybrid");
    expect(hy.hits[0].path).toBe("200_silver/204_books/ラーメン本.md");

    // frontmatter filter evaluated against SQLite
    const f = await search(cfg, db, "殺人", { mode: "keyword", filters: [{ field: "rating", op: ">=", value: "5" }] }, { store, embedder: emb });
    expect(f.hits.map((h) => h.path)).toEqual(["200_silver/204_books/十角館の殺人.md"]);
    const f2 = await search(cfg, db, "殺人", { mode: "keyword", filters: [{ field: "type", op: "=", value: "media" }] }, { store, embedder: emb });
    expect(f2.hits).toHaveLength(0);
  });

  test("falls back to SQLite when Ollama is down (hybrid degrades, vector falls back)", async () => {
    const db = openDb(cfg);
    const store = await VectorStore.open(cfg);
    const down: Embedder = { profile: emb.profile, ping: async () => ({ ok: false, reason: "ollama unreachable" }), embed: async () => { throw new Error("no"); } };
    const hy = await search(cfg, db, "殺人", { mode: "hybrid" }, { store, embedder: down });
    expect(hy.mode).toBe("keyword");
    expect(hy.degraded).toContain("ollama unreachable");
    expect(hy.hits[0].path).toBe("200_silver/204_books/十角館の殺人.md");
    const v = await search(cfg, db, "殺人", { mode: "vector" }, { store, embedder: down });
    expect(v.mode).toBe("keyword");
    expect(v.hits.length).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  const row = (id: string): ChunkRow => ({ id, path: id, note_path: id, idx: 0, heading: "", text: "", spoiler: false, type: "", domain: "", status: "", archived: false, updated: "", note_hash: "", vector: [] });
  test("rrf fuses ranks and records provenance", () => {
    const r = rrf([{ via: "vector", rows: [row("a"), row("b")] }, { via: "keyword", rows: [row("b"), row("c")] }]);
    expect(r[0].row.id).toBe("b");
    expect(r[0].via).toEqual(["vector", "keyword"]);
    expect(r[0].score).toBeCloseTo(1 / 61 + 1 / 62);
  });
  test("buildWhere escapes and skips non-lance fields", () => {
    expect(buildWhere([{ field: "type", op: "=", value: "bo'ok" }, { field: "rating", op: ">=", value: "4" }], false)).toBe("archived = false AND type = 'bo''ok'");
    expect(buildWhere([], true)).toBeUndefined();
  });
  test("snippet centers on the first term", () => {
    const s = snippet("x".repeat(300) + "ラーメン" + "y".repeat(300), "ラーメン", 60);
    expect(s).toContain("ラーメン");
    expect(s.startsWith("…")).toBe(true);
  });
});
