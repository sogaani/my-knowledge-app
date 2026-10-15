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
  /** `900_system/similar.json` (SIMILAR_REL): nearest notes, tracked in git so the API pod gets them. */
  similarPath: string;
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
  /** `kb location import`: Places API (New) key (env GOOGLE_MAPS_API_KEY wins), cache TTL (≤ 30 days), API calls per run */
  places?: { api_key?: string; cache_ttl_days?: number; max_lookups?: number };
  [k: string]: unknown;
}

/**
 * Data repo layout. Hundreds digit = layer, last two digits = domain (Silver and Gold share the domain number: 204_books ↔ 304_books).
 * Every path into the data repo goes through these; do not hard-code folder names elsewhere.
 */
export const LAYOUT = {
  inbox: "000_inbox",
  bronze: "100_bronze",
  silver: "200_silver",
  gold: "300_gold",
  templates: "800_templates",
  system: "900_system",
} as const;

/** Gold files and folders (relative to LAYOUT.gold). `kb build` writes them; the WebUI reads some by name. */
export const GOLD = {
  home: "300_home.md",
  market: "300_market.md",
  learning: "301_learning",
  subscriptions: "302_subscriptions.md",
  finance: "303_finance.md",
  books: "304_books",
  media: "305_media",
  projects: "306_projects.md",
  suggestions: "307_suggestions.md",
  trading: "308_trading.md",
  /** Daily RSS picks (articles.ts); the data itself is 900_system/articles/*.json. */
  articles: "309_articles.md",
  health: "310_health.md",
  location: "311_location.md",
  // 39x: views across domains (no domain number of their own)
  daily: "390_daily.md",
  trends: "391_trends.md",
  upcoming: "392_upcoming.md",
  /** Plaintext (unlike 390–392): encrypted domains appear by count only. */
  resurface: "393_resurface.md",
} as const;

/**
 * Nearest notes per note (from the LanceDB header chunks), written by `kb embed` on the Mac and committed with the
 * data repo so the API pod (no LanceDB) can load it into its SQLite `similar` table. Paths and scores only.
 */
export const SIMILAR_REL = `${LAYOUT.system}/similar.json`;

/** Repo-relative prefixes, for `path.startsWith(...)` and SQL `LIKE` checks. */
export const SILVER_PREFIX = `${LAYOUT.silver}/`;
export const GOLD_PREFIX = `${LAYOUT.gold}/`;
/** Work projects (encrypted domain) live outside the project schema's folder. */
export const WORK_FOLDER = `${LAYOUT.silver}/207_work`;
/**
 * Silver domains the data repo encrypts with git-crypt (its `.gitattributes` is the source of truth; keep in sync).
 * Plaintext Gold and plaintext notes may mention these by count or aggregate only, never by title / summary / link.
 */
export const ENCRYPTED_DOMAINS = ["202_subscriptions", "203_finance", "207_work", "210_health", "211_location", "212_calendar"] as const;
/** True for a repo-relative path inside an encrypted Silver domain. */
export function isEncryptedPath(rel: string): boolean {
  return ENCRYPTED_DOMAINS.some((d) => rel.startsWith(`${SILVER_PREFIX}${d}/`));
}
/** The encrypted domain folder (e.g. `203_finance`) a repo-relative path belongs to, or null. */
export function encryptedDomainOf(rel: string): string | null {
  return ENCRYPTED_DOMAINS.find((d) => rel.startsWith(`${SILVER_PREFIX}${d}/`)) ?? null;
}

/** Resolve the data repo root from KB_ROOT or by walking up to a dir that has AGENTS.md + the Silver folder. */
export function findRoot(start?: string): string {
  if (process.env.KB_ROOT) return resolve(process.env.KB_ROOT);
  let dir = resolve(start ?? process.cwd());
  for (;;) {
    if (existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, LAYOUT.silver))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error("KB root not found; set KB_ROOT");
    dir = parent;
  }
}

export function loadConfig(root = findRoot()): KbConfig {
  const sys = join(root, LAYOUT.system);
  const localPath = join(sys, "config.local.toml");
  const local = existsSync(localPath) ? (parseToml(readFileSync(localPath, "utf8")) as LocalConfig) : {};
  return {
    root,
    inbox: join(root, LAYOUT.inbox),
    bronze: join(root, LAYOUT.bronze),
    silver: join(root, LAYOUT.silver),
    gold: join(root, LAYOUT.gold),
    templates: join(root, LAYOUT.templates),
    schemas: join(sys, "schemas"),
    cache: join(sys, "cache"),
    logs: join(sys, "logs"),
    dbPath: process.env.KB_DB ?? join(sys, "cache", "kb.sqlite"),
    lanceDir: process.env.KB_LANCE ?? join(sys, "cache", "lance"),
    langModelHome: process.env.LANCE_LANGUAGE_MODEL_HOME ?? join(sys, "cache", "lance", "language_models"),
    similarPath: join(root, SIMILAR_REL),
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
