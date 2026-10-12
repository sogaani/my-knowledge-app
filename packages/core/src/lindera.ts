/**
 * Lindera (Japanese morphological analyzer) dictionary management for LanceDB full-text search.
 * The lindera crate is compiled into @lancedb/lancedb's native binary; only the dictionary files are external.
 * The dictionary version MUST match the lindera version inside the pinned @lancedb/lancedb release.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type { KbConfig } from "./config";

/** @lancedb/lancedb 0.40.0 bundles lindera 3.0.7. Update both together (see .agents/skills/upgrade-lancedb). */
export const LANCEDB_VERSION = "0.40.0";
export const LINDERA_VERSION = "3.0.7";
export const DEFAULT_TOKENIZER = "lindera/ipadic";
export const FALLBACK_TOKENIZER = "icu";

export interface LinderaStatus { ok: boolean; dict: string; dir: string; version?: string; reason?: string }

export function linderaDictName(tokenizer: string): string | null {
  const m = /^lindera\/([a-z0-9-]+)$/.exec(tokenizer);
  return m ? m[1] : null;
}

/** Point Lance at the repo-local language model home unless the user set one. Call before any FTS work. */
export function applyLanguageModelHome(cfg: KbConfig) {
  if (!process.env.LANCE_LANGUAGE_MODEL_HOME) process.env.LANCE_LANGUAGE_MODEL_HOME = cfg.langModelHome;
  setNativeEnv("LANCE_LANGUAGE_MODEL_HOME", process.env.LANCE_LANGUAGE_MODEL_HOME);
}

/**
 * Bun's process.env is not mirrored into the C environment, and Lance's native code reads the variable with getenv:
 * without this it falls back to ~/Library/Application Support/lance and the Lindera tokenizer is not found.
 */
function setNativeEnv(key: string, value: string) {
  try {
    const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
      setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    });
    libc.symbols.setenv(Buffer.from(`${key}\0`), Buffer.from(`${value}\0`), 1);
    libc.close();
  } catch { /* no libc to call (unusual platform): Lance then needs the variable set by the caller */ }
}

export function linderaStatus(cfg: KbConfig, tokenizer = cfg.embedding.tokenizer): LinderaStatus {
  const dict = linderaDictName(tokenizer) ?? "ipadic";
  const dir = join(cfg.langModelHome, "lindera", dict);
  const versionFile = join(dir, "VERSION");
  if (!existsSync(join(dir, "config.yml"))) return { ok: false, dict, dir, reason: `no dictionary at ${dir} (run: kb embed --setup)` };
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : undefined;
  if (version && version !== LINDERA_VERSION) return { ok: false, dict, dir, version, reason: `dictionary ${version} != lindera ${LINDERA_VERSION} in @lancedb/lancedb ${LANCEDB_VERSION} (run: kb embed --setup)` };
  return { ok: true, dict, dir, version };
}

/** Decide the FTS tokenizer: configured lindera/* if its dictionary is present, else ICU (no files needed). */
export function resolveTokenizer(cfg: KbConfig): { tokenizer: string; fallback?: string } {
  const want = cfg.embedding.tokenizer || DEFAULT_TOKENIZER;
  if (!want.startsWith("lindera/")) return { tokenizer: want };
  const st = linderaStatus(cfg, want);
  return st.ok ? { tokenizer: want } : { tokenizer: FALLBACK_TOKENIZER, fallback: st.reason };
}

/** Download the prebuilt dictionary from lindera's GitHub release and write Lance's config.yml. */
export async function setupLindera(cfg: KbConfig, tokenizer = cfg.embedding.tokenizer, log: (s: string) => void = () => {}): Promise<LinderaStatus> {
  const dict = linderaDictName(tokenizer) ?? "ipadic";
  const dir = join(cfg.langModelHome, "lindera", dict);
  const url = `https://github.com/lindera/lindera/releases/download/v${LINDERA_VERSION}/lindera-${dict}-${LINDERA_VERSION}.zip`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, "dict.zip");
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  const unzip = Bun.spawn(["unzip", "-q", "-o", zip, "-d", dir], { stdout: "pipe", stderr: "pipe" });
  if ((await unzip.exited) !== 0) throw new Error(`unzip failed: ${await new Response(unzip.stderr).text()}`);
  rmSync(zip, { force: true });
  const dictDir = join(dir, `lindera-${dict}`);
  if (!existsSync(join(dictDir, "dict.da"))) throw new Error(`unexpected archive layout: ${dictDir}/dict.da missing`);
  writeFileSync(join(dir, "config.yml"), linderaConfigYaml(dictDir));
  writeFileSync(join(dir, "VERSION"), `${LINDERA_VERSION}\n`);
  log(`installed lindera/${dict} ${LINDERA_VERSION} -> ${dir}`);
  return linderaStatus(cfg, tokenizer);
}

/**
 * Lindera analyzer config used for both indexing and query tokenization. Particles, auxiliaries and
 * punctuation (助詞・助動詞・記号) are dropped so BM25 does not match every note on の/で/は.
 */
export function linderaConfigYaml(dictDir: string): string {
  return [
    "segmenter:",
    '  mode: "normal"',
    `  dictionary: "${dictDir}"`,
    "token_filters:",
    '  - kind: "japanese_stop_tags"',
    "    args:",
    "      tags:",
    ...["接続詞", "助詞", "助詞,格助詞", "助詞,格助詞,一般", "助詞,格助詞,引用", "助詞,格助詞,連語", "助詞,係助詞", "助詞,副助詞", "助詞,間投助詞",
        "助詞,並立助詞", "助詞,終助詞", "助詞,副助詞／並立助詞／終助詞", "助詞,連体化", "助詞,副詞化", "助詞,特殊", "助動詞",
        "記号", "記号,一般", "記号,読点", "記号,句点", "記号,空白", "記号,括弧閉", "記号,括弧開", "その他,間投", "フィラー", "非言語音"].map((t) => `        - "${t}"`),
    "",
  ].join("\n");
}
