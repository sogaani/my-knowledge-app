/** LanceDB under Bun: create / incremental embed / FTS / vector / hybrid search, with a deterministic fake embedder. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type KbConfig } from "./config";
import { openDb, indexNotes } from "./db";
import type { Embedder, EmbedProfile } from "./embed";
import { VectorStore, embedNotes } from "./vector";
import { search, rrf, cutoff, confidence, buildWhere, snippet, THIN_WEIGHT, VECTOR_CUTOFF, VECTOR_STRONG } from "./search";
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
  write("200_silver/204_books/積読.md", { type: "book", title: "積読の本", status: "todo", tags: [], summary: "おすすめから追加", updated: "2026-10-03" }, "# 積読の本\n");
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
    expect(s1.embedded).toBe(4);
    expect(s1.rows).toBeGreaterThanOrEqual(6);
    expect(store.meta?.tokenizer).toBe("icu");
    expect(store.meta?.dim).toBe(DIM);

    const s2 = await embedNotes(cfg, store, emb, {});
    expect(s2.embedded).toBe(0);
    expect(s2.skipped).toBe(4);

    write("200_silver/204_books/ラーメン本.md", { type: "book", title: "東京ラーメン百選", status: "done", tags: ["food"], rating: 4, summary: "東京のラーメン店ガイド", updated: "2026-10-03" }, "## メモ\n\n読了。");
    rmSync(join(root, "200_silver/205_media/_archive/old.md"));
    indexNotes(cfg, db);
    const s3 = await embedNotes(cfg, store, emb, {});
    expect(s3.embedded).toBe(1);
    expect(s3.removed).toBe(1);
    const hashes = await store.existingHashes();
    expect([...hashes.keys()].sort()).toEqual(["200_silver/204_books/ラーメン本.md", "200_silver/204_books/十角館の殺人.md", "200_silver/204_books/積読.md"]);
    const thinRows = (await store.table!.query().where("thin = true").select(["note_path"]).toArray()) as { note_path: string }[];
    expect(thinRows.map((r) => r.note_path)).toEqual(["200_silver/204_books/積読.md"]);

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
    // distances / scores come back from Lance and a keyword hit containing the term is high confidence
    expect(hy.hits[0].confidence).toBe("high");
    const top = hy.hits[0].matches[0];
    expect(top.via).toContain("keyword");
    expect(top.bm25).toBeGreaterThan(0);
    expect(top.vectorDistance).toBeGreaterThanOrEqual(0);
    expect(hy.hits.every((h) => h.confidence === "high" || h.confidence === "low")).toBe(true);
    const kwOnly = await search(cfg, db, "ラーメン", { mode: "keyword" }, { store, embedder: emb });
    expect(kwOnly.hits[0].matches[0].vectorDistance).toBeUndefined();
    expect(kwOnly.hits[0].matches[0].bm25).toBeGreaterThan(0);

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
    expect(hy.hits[0].confidence).toBe("high");
    const v = await search(cfg, db, "殺人", { mode: "vector" }, { store, embedder: down });
    expect(v.mode).toBe("keyword");
    expect(v.hits.length).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  const row = (id: string): ChunkRow => ({ id, path: id, note_path: id, idx: 0, heading: "", text: "", spoiler: false, thin: false, type: "", domain: "", status: "", archived: false, updated: "", note_hash: "", vector: [] });
  test("rrf fuses ranks and records provenance", () => {
    const r = rrf([{ via: "vector", rows: [row("a"), row("b")] }, { via: "keyword", rows: [row("b"), row("c")] }]);
    expect(r[0].row.id).toBe("b");
    expect(r[0].via).toEqual(["vector", "keyword"]);
    expect(r[0].score).toBeCloseTo(1 / 61 + 1 / 62);
    // both measures survive fusion whichever retriever listed the chunk first
    const m = rrf([{ via: "vector", rows: [{ ...row("x"), _distance: 0.4 }] }, { via: "keyword", rows: [{ ...row("x"), _score: 7 }] }]);
    expect(m[0].row._distance).toBe(0.4);
    expect(m[0].row._score).toBe(7);
  });
  test("rrf weighs vector-only thin chunks down, keyword hits on thin chunks keep full weight", () => {
    const thin = { ...row("t"), thin: true };
    const r = rrf([{ via: "vector", rows: [thin, row("a")] }]);
    expect(r[0].row.id).toBe("a");
    expect(r[1].score).toBeCloseTo(THIN_WEIGHT / 61);
    const r2 = rrf([{ via: "vector", rows: [thin, row("a")] }, { via: "keyword", rows: [thin] }]);
    expect(r2[0].row.id).toBe("t");
    expect(r2[0].score).toBeCloseTo(2 / 61);
  });
  test("cutoff drops far vector-only chunks without a query term; keyword hits and lexical matches survive", () => {
    const far = { ...row("far"), _distance: VECTOR_CUTOFF + 0.05 };
    const near = { ...row("near"), _distance: VECTOR_CUTOFF - 0.05 };
    const farLex = { ...row("farlex"), text: "東京のラーメン店", _distance: VECTOR_CUTOFF + 0.1 };
    const farKw = { ...row("farkw"), _distance: VECTOR_CUTOFF + 0.1 };
    const kept = cutoff(rrf([{ via: "vector", rows: [far, near, farLex, farKw] }, { via: "keyword", rows: [farKw] }]), ["ラーメン"]);
    expect(kept.map((f) => f.row.id).sort()).toEqual(["farkw", "farlex", "near"]);
    // every candidate off-topic → nothing left (the caller returns 0 hits instead of `limit` neighbours)
    expect(cutoff(rrf([{ via: "vector", rows: [far] }]), ["ラーメン"])).toHaveLength(0);
    // rows without a distance (older callers / keyword mode) are never dropped
    expect(cutoff(rrf([{ via: "vector", rows: [row("nodist")] }]), ["x"])).toHaveLength(1);
  });
  test("confidence: keyword hit with the term, or a close non-thin vector neighbour, is high; the rest low", () => {
    const terms = ["ラーメン"];
    const kwWithTerm = rrf([{ via: "keyword", rows: [{ ...row("a"), text: "ラーメン" }] }]);
    expect(confidence(kwWithTerm, terms)).toBe("high");
    const kwSubtoken = rrf([{ via: "keyword", rows: [{ ...row("b"), text: "ラー油", _distance: 0.6 }] }]);
    expect(confidence(kwSubtoken, terms)).toBe("low");
    const close = rrf([{ via: "vector", rows: [{ ...row("c"), _distance: VECTOR_STRONG - 0.01 }] }]);
    expect(confidence(close, terms)).toBe("high");
    const closeThin = rrf([{ via: "vector", rows: [{ ...row("d"), thin: true, _distance: VECTOR_STRONG - 0.01 }] }]);
    expect(confidence(closeThin, terms)).toBe("low");
    const loose = rrf([{ via: "vector", rows: [{ ...row("e"), _distance: (VECTOR_STRONG + VECTOR_CUTOFF) / 2 }] }]);
    expect(confidence(loose, terms)).toBe("low");
    // one strong chunk is enough for the note
    expect(confidence([...loose, ...close], terms)).toBe("high");
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
