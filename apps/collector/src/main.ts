#!/usr/bin/env bun
/**
 * Bronze collectors (Mac): pull GitHub / Gmail / Calendar / YouTube / Google Health / LinkedIn export / RSS feeds into 000_inbox.
 *   bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *   bun run collect status
 *   bun run collect auth [google | google-health]   (no name: both, one after the other)
 * While the Google consent screen stays in "Testing", refresh tokens die 7 days after consent: the daily run warns
 * (macOS notification) the day before and when one has expired; `bun run collect auth` renews both.
 * Logic lives in @kb/core (collect/); this is the entry point that owns the .env with the secrets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTORS, GOOGLE_TOKENS, authorizeGoogle, isExpiredTokenError, loadConfig, loadState, runCollectors, tokenExpiry, type SourceReport } from "@kb/core";

const ENV_FILE = join(import.meta.dir, "..", ".env");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1]!.startsWith("--") ? args.splice(i, 2)[1] : (args.splice(i, 1), "true");
};

/** Replace or append KEY=value in the .env (keeps comments and order). */
function setEnvVar(key: string, value: string) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(ENV_FILE, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`, { mode: 0o600 });
}

const parseDate = (s: string | undefined) => {
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`bad date ${s} (YYYY-MM-DD)`);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

async function main() {
  if (args[0] === "auth") {
    // Gmail / Calendar / YouTube share one token; the Health API needs a token with health scopes only
    const targets = args[1] ? GOOGLE_TOKENS.filter((t) => t.name === args[1]) : [...GOOGLE_TOKENS];
    if (!targets.length) throw new Error(`usage: bun run collect auth [${GOOGLE_TOKENS.map((t) => t.name).join(" | ")}]`);
    for (const t of targets) {
      console.log(`[${t.label}] ブラウザで Google の同意画面を開きます（127.0.0.1:8789 で受け取ります）…`);
      const { refreshToken, scopes } = await authorizeGoogle(process.env, { scopes: [...t.scopes] });
      const issuedAt = new Date().toISOString();
      setEnvVar(t.envVar, refreshToken);
      setEnvVar(`${t.envVar}_ISSUED_AT`, issuedAt);
      process.env[`${t.envVar}_ISSUED_AT`] = issuedAt;
      const { expiresAt } = tokenExpiry(process.env, t.envVar);
      console.log(`${t.envVar} を ${ENV_FILE} に書き込みました${expiresAt ? `（期限 ${fmt(expiresAt)}）` : ""}。許可されたスコープ:\n  ${scopes.split(" ").join("\n  ")}`);
    }
    return;
  }

  const cfg = loadConfig();
  if (args[0] === "status") {
    const state = loadState(cfg);
    for (const c of COLLECTORS) {
      const ok = c.configured(process.env);
      const st = state[c.id];
      console.log(`${c.id.padEnd(9)} ${ok === true ? "configured" : `skipped: ${ok}`}${st?.lastRunAt ? ` | last run ${st.lastRunAt}` : ""}${st?.lastTo ? ` | collected to ${st.lastTo.slice(0, 10)}` : ""}${st?.lastError ? ` | last error: ${st.lastError}` : ""}`);
    }
    console.log("");
    for (const t of GOOGLE_TOKENS) {
      if (!process.env[t.envVar]) { console.log(`${t.envVar}: 未設定（bun run collect auth ${t.name}）`); continue; }
      const { issuedAt, expiresAt, daysLeft } = tokenExpiry(process.env, t.envVar);
      if (!issuedAt) console.log(`${t.envVar}: 発行日時不明（bun run collect auth ${t.name} で取り直すと期限を追える）`);
      else if (!expiresAt) console.log(`${t.envVar}: 発行 ${fmt(issuedAt)}（期限なし: GOOGLE_TOKEN_TTL_DAYS=0）`);
      else console.log(`${t.envVar}: 発行 ${fmt(issuedAt)} / 期限 ${fmt(expiresAt)}（${daysLeft! > 0 ? `残り ${daysLeft!.toFixed(1)} 日` : "期限切れ"}）`);
    }
    return;
  }

  const from = parseDate(flag("from")), to = parseDate(flag("to"));
  const dryRun = flag("dry-run") !== undefined;
  const started = Date.now();
  console.log(`[collect ${new Date().toISOString()}] ${dryRun ? "(dry run) " : ""}kb=${cfg.root}`);
  const reports = await runCollectors(cfg, process.env, { only: args.length ? args : undefined, from, to, dryRun });
  for (const r of reports) {
    const range = r.from ? ` ${r.from}..${r.to}` : "";
    if (r.status === "ok") console.log(`  ${r.id}: ok${range} items=${r.items ?? 0} wrote=${r.written.length}${r.skippedExisting.length ? ` already-in-inbox=${r.skippedExisting.length}` : ""}`);
    else console.log(`  ${r.id}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const warnings = tokenWarnings(reports);
  for (const w of warnings) console.log(`  WARN ${w}`);
  if (warnings.length && !dryRun) notify(warnings.join("\n"));
  if (reports.some((r) => r.status === "failed")) process.exitCode = 1;
}

const fmt = (d: Date) => d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Tokens that died (a source failed with invalid_grant) or will die within a day. */
function tokenWarnings(reports: SourceReport[]): string[] {
  const out: string[] = [];
  for (const t of GOOGLE_TOKENS) {
    if (!process.env[t.envVar]) continue;
    const dead = reports.some((r) => r.status === "failed" && r.reason?.includes(t.envVar) && isExpiredTokenError(r.reason));
    const { expiresAt, daysLeft } = tokenExpiry(process.env, t.envVar);
    if (dead || (daysLeft !== undefined && daysLeft <= 0)) out.push(`${t.label} のトークンが切れました。bun run collect auth ${t.name}`);
    else if (daysLeft !== undefined && daysLeft <= 1.5) out.push(`${t.label} のトークンは ${fmt(expiresAt!)} に切れます。bun run collect auth ${t.name}`);
  }
  return out;
}

/** macOS notification (the daily run is launchd: nobody reads its log). Silently skipped elsewhere. */
function notify(text: string) {
  if (process.platform !== "darwin") return;
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  try { Bun.spawnSync(["osascript", "-e", `display notification ${q(text)} with title "my-knowledge collector" sound name "default"`]); } catch { /* best effort */ }
}

main().catch((e) => {
  console.error(`collect: ${(e as Error).message ?? e}`);
  process.exit(1);
});
