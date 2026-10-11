import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface KbConfig {
  root: string;
  inbox: string;
  bronze: string;
  silver: string;
  gold: string;
  templates: string;
  schemas: string;
  cache: string;
  logs: string;
  dbPath: string;
  /** LanceDB directory (vector + FTS index over Silver chunks). Derived, gitignored. */
  lanceDir: string;
  /** Lance language-model home (Lindera dictionaries). Derived, gitignored. */
  langModelHome: string;
  embedding: EmbeddingConfig;
  local: LocalConfig;
}
export interface EmbeddingConfig {
  /** false => `kb index`/`kb build` skip embedding entirely (e.g. the k8s API pod). Env: KB_EMBED=off */
  enabled: boolean;
  /** Ollama model tag. Env: KB_EMBED_MODEL */
  model: string;
  /** Ollama base URL. Env: OLLAMA_HOST */
  host: string;
  /** LanceDB FTS base tokenizer: lindera/ipadic (default, needs dictionary) | icu | ngram | simple. Env: KB_FTS_TOKENIZER */
  tokenizer: string;
  batchSize: number;
}
export interface LocalConfig {
  backup?: { dest?: string };
  prune?: { keepYears?: number };
  embedding?: Partial<EmbeddingConfig>;
  [k: string]: unknown;
}

/** Resolve the data repo root from KB_ROOT or by walking up to a dir that has AGENTS.md + 20_silver. */
export function findRoot(start?: string): string {
  if (process.env.KB_ROOT) return resolve(process.env.KB_ROOT);
  let dir = resolve(start ?? process.cwd());
  for (;;) {
    if (existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, "20_silver"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error("KB root not found; set KB_ROOT");
    dir = parent;
  }
}

export function loadConfig(root = findRoot()): KbConfig {
  const localPath = join(root, "90_system", "config.local.toml");
  const local = existsSync(localPath) ? (parseToml(readFileSync(localPath, "utf8")) as LocalConfig) : {};
  return {
    root,
    inbox: join(root, "00_inbox"),
    bronze: join(root, "10_bronze"),
    silver: join(root, "20_silver"),
    gold: join(root, "30_gold"),
    templates: join(root, "80_templates"),
    schemas: join(root, "90_system", "schemas"),
    cache: join(root, "90_system", "cache"),
    logs: join(root, "90_system", "logs"),
    dbPath: process.env.KB_DB ?? join(root, "90_system", "cache", "kb.sqlite"),
    lanceDir: process.env.KB_LANCE ?? join(root, "90_system", "cache", "lance"),
    langModelHome: process.env.LANCE_LANGUAGE_MODEL_HOME ?? join(root, "90_system", "cache", "lance", "language_models"),
    embedding: embeddingConfig(local.embedding ?? {}),
    local,
  };
}

export const today = (): string => new Date().toISOString().slice(0, 10);

function embeddingConfig(l: Partial<EmbeddingConfig>): EmbeddingConfig {
  const env = process.env;
  const enabled = env.KB_EMBED ? !["off", "0", "false"].includes(env.KB_EMBED.toLowerCase()) : l.enabled ?? true;
  const host = (env.OLLAMA_HOST && /^https?:\/\//.test(env.OLLAMA_HOST) ? env.OLLAMA_HOST : env.OLLAMA_HOST ? `http://${env.OLLAMA_HOST}` : l.host) ?? "http://127.0.0.1:11434";
  return {
    enabled,
    model: env.KB_EMBED_MODEL ?? l.model ?? "bge-m3",
    host: host.replace(/\/$/, ""),
    tokenizer: env.KB_FTS_TOKENIZER ?? l.tokenizer ?? "lindera/ipadic",
    batchSize: Number(l.batchSize ?? 16),
  };
}
