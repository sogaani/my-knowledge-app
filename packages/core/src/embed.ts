/**
 * Embedding client (Ollama). Dense vectors only — Ollama exposes neither bge-m3's sparse weights nor
 * its multi-vector output, so the lexical side of search is BM25 over Lindera tokens (see vector.ts).
 */
import type { KbConfig } from "./config";

export interface EmbedProfile {
  /** Ollama model tag, e.g. "bge-m3" or "qwen3-embedding:0.6b" */
  model: string;
  dim: number;
  /** Prepended to search queries (asymmetric models). */
  queryPrefix: string;
  /** Prepended to indexed passages. */
  docPrefix: string;
}

/** Known models. Unknown models get dim probed at runtime and no prefixes. */
const PROFILES: Record<string, Partial<Record<"dim" | "queryPrefix" | "docPrefix", unknown>> & { dims?: Record<string, number> }> = {
  "bge-m3": { dim: 1024 },
  "qwen3-embedding": {
    dims: { "0.6b": 1024, "4b": 2560, "8b": 4096 },
    queryPrefix: "Instruct: Given a search query, retrieve relevant notes from a personal knowledge base\nQuery: ",
  },
  embeddinggemma: { dim: 768, queryPrefix: "task: search result | query: ", docPrefix: "title: none | text: " },
  "snowflake-arctic-embed2": { dim: 1024, queryPrefix: "query: " },
  "nomic-embed-text": { dim: 768, queryPrefix: "search_query: ", docPrefix: "search_document: " },
  "mxbai-embed-large": { dim: 1024, queryPrefix: "Represent this sentence for searching relevant passages: " },
};

export function profileFor(model: string): EmbedProfile {
  const [base, tag] = model.split(":");
  const p = PROFILES[base] ?? {};
  const dim = (tag && p.dims?.[tag]) || (p.dim as number | undefined) || 0;
  return { model, dim, queryPrefix: String(p.queryPrefix ?? ""), docPrefix: String(p.docPrefix ?? "") };
}

export interface Embedder {
  readonly profile: EmbedProfile;
  /** Cheap liveness check; returns a reason when unusable. */
  ping(): Promise<{ ok: true } | { ok: false; reason: string }>;
  embed(texts: string[], kind: "query" | "doc"): Promise<number[][]>;
}

export class OllamaEmbedder implements Embedder {
  profile: EmbedProfile;
  constructor(private host: string, model: string, private batchSize = 16) {
    this.profile = profileFor(model);
  }

  async ping(): Promise<{ ok: true } | { ok: false; reason: string }> {
    let tags: { models?: { name: string; model?: string }[] };
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { ok: false, reason: `ollama ${res.status} at ${this.host}` };
      tags = (await res.json()) as typeof tags;
    } catch (e) {
      return { ok: false, reason: `ollama unreachable at ${this.host} (${(e as Error).message})` };
    }
    const want = this.profile.model.includes(":") ? this.profile.model : `${this.profile.model}:latest`;
    const have = (tags.models ?? []).some((m) => m.name === want || m.model === want || m.name === this.profile.model);
    if (!have) return { ok: false, reason: `model ${this.profile.model} not pulled (run: ollama pull ${this.profile.model})` };
    return { ok: true };
  }

  async embed(texts: string[], kind: "query" | "doc"): Promise<number[][]> {
    const prefix = kind === "query" ? this.profile.queryPrefix : this.profile.docPrefix;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const input = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
      const res = await fetch(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.profile.model, input, truncate: true, keep_alive: "10m" }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { embeddings: number[][] };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) throw new Error("ollama embed: unexpected response shape");
      out.push(...body.embeddings);
    }
    if (out.length && !this.profile.dim) this.profile.dim = out[0].length;
    return out;
  }

  /** Resolve the vector dimension (from the profile table, or by embedding one short string). */
  async dim(): Promise<number> {
    if (!this.profile.dim) await this.embed(["dimension probe"], "doc");
    return this.profile.dim;
  }
}

export function makeEmbedder(cfg: KbConfig): OllamaEmbedder {
  const e = cfg.embedding;
  return new OllamaEmbedder(e.host, e.model, e.batchSize);
}
