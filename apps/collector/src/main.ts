#!/usr/bin/env bun
/**
 * Bronze collectors (Mac): pull GitHub / Gmail / Calendar / YouTube / Google Health / LinkedIn export / RSS feeds into 000_inbox.
 *   bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *   bun run collect status
 *   bun run collect auth [google | google-health]   (no name: both, one after the other)
 * While the Google consent screen stays in "Testing", refresh tokens die 7 days after consent; the GitHub PAT dies on
 * the date recorded as GITHUB_TOKEN_EXPIRES. The daily run warns (macOS notification) ahead of either and when one has
 * expired, and leaves the expiry dates in collect-tokens.json for the morning ops digest. `bun run collect auth` renews
 * the Google ones. Every command chmods the .env to 0600.
 * Logic lives in @kb/core (collect/); this is the entry point that owns the .env with the secrets.
 */
import { join } from "node:path";
import {
  COLLECTORS, GOOGLE_TOKENS, authorizeGoogle, isExpiredTokenError, loadConfig, loadState, runCollectors, saveTokenExpiries,
  secureEnvFile, setEnvVar, tokenExpiry, tokenStatuses, tokenWarnings, formatDays, ymd, type TokenStatus,
} from "@kb/core";

const ENV_FILE = join(import.meta.dir, "..", ".env");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1]!.startsWith("--") ? args.splice(i, 2)[1] : (args.splice(i, 1), "true");
};

const parseDate = (s: string | undefined) => {
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`bad date ${s} (YYYY-MM-DD)`);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

async function main() {
  if (secureEnvFile(ENV_FILE)) console.log(`[collect] chmod 600 ${ENV_FILE}`);

  if (args[0] === "auth") {
    // Gmail / Calendar / YouTube share one token; the Health API needs a token with health scopes only
    const targets = args[1] ? GOOGLE_TOKENS.filter((t) => t.name === args[1]) : [...GOOGLE_TOKENS];
    if (!targets.length) throw new Error(`usage: bun run collect auth [${GOOGLE_TOKENS.map((t) => t.name).join(" | ")}]`);
    for (const t of targets) {
      console.log(`[${t.label}] ブラウザで Google の同意画面を開きます（127.0.0.1:8789 で受け取ります）…`);
      const { refreshToken, scopes } = await authorizeGoogle(process.env, { scopes: [...t.scopes] });
      const issuedAt = new Date().toISOString();
      setEnvVar(ENV_FILE, t.envVar, refreshToken);
      setEnvVar(ENV_FILE, `${t.envVar}_ISSUED_AT`, issuedAt);
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
    for (const s of tokenStatuses(process.env)) console.log(tokenStatusLine(s));
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
  const statuses = tokenStatuses(process.env);
  if (!dryRun) saveTokenExpiries(cfg, statuses);
  // a Google token that died shows up as a source failing with invalid_grant naming its env var
  const dead = (s: TokenStatus) => reports.some((r) => r.status === "failed" && r.reason?.includes(s.envVar) && isExpiredTokenError(r.reason));
  const warnings = tokenWarnings(statuses, dead, fmt);
  for (const w of warnings) console.log(`  WARN ${w}`);
  if (warnings.length && !dryRun) notify(warnings.join("\n"));
  if (reports.some((r) => r.status === "failed")) process.exitCode = 1;
}

const fmt = (d: Date) => d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One `status` line per credential: issue / expiry / days left, or how to start tracking it. */
function tokenStatusLine(s: TokenStatus): string {
  if (!s.configured) return `${s.envVar}: 未設定（${s.id === "github" ? "fine-grained PAT を GITHUB_TOKEN に" : s.renew}）`;
  if (s.id === "github") {
    if (!s.expiresAt) return `${s.envVar}: 期限不明（PAT の有効期限を GITHUB_TOKEN_EXPIRES=YYYY-MM-DD に書くと追える）`;
    return `${s.envVar}: 期限 ${ymd(s.expiresAt)}（${s.daysLeft! > 0 ? `残り ${formatDays(s.daysLeft!)}` : "期限切れ"}）`;
  }
  if (!s.issuedAt) return `${s.envVar}: 発行日時不明（${s.renew} で取り直すと期限を追える）`;
  if (!s.expiresAt) return `${s.envVar}: 発行 ${fmt(s.issuedAt)}（期限なし: GOOGLE_TOKEN_TTL_DAYS=0）`;
  return `${s.envVar}: 発行 ${fmt(s.issuedAt)} / 期限 ${fmt(s.expiresAt)}（${s.daysLeft! > 0 ? `残り ${formatDays(s.daysLeft!)}` : "期限切れ"}）`;
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
