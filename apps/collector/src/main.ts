#!/usr/bin/env bun
/**
 * Bronze collectors (Mac): pull GitHub / Gmail / Calendar / YouTube / Google Health / LinkedIn export / RSS feeds into 000_inbox.
 *   bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]   (source: `calendar` = every account, `calendar@work` = one)
 *   bun run collect status
 *   bun run collect auth [google | google-health]   (no name: both, one after the other)
 *   bun run collect auth google --account <name> [--sources gmail,calendar,meet]   (an extra Google account; see core collect/accounts.ts)
 * No credential expiry is tracked: when a source fails because Google or GitHub refused its token, the daily run sends
 * a macOS notification naming the credential (`bun run collect auth` renews the Google ones). Every command chmods
 * the .env to 0600.
 * Logic lives in @kb/core (collect/); this is the entry point that owns the .env with the secrets.
 */
import { join } from "node:path";
import { ACCOUNT_RE, COLLECTORS, GOOGLE_TOKENS, authFailures, authorizeGoogle, collectorInstances, loadConfig, loadState, parseGoogleSources, runCollectors, scopesFor, secureEnvFile, setEnvVar } from "@kb/core";

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
    const account = flag("account"), sourcesArg = flag("sources");
    if (account !== undefined) {
      // an extra Google account: its own refresh token, only the scopes of the sources it runs (Health stays single-account)
      if (!ACCOUNT_RE.test(account)) throw new Error(`--account must match ${ACCOUNT_RE} (got ${JSON.stringify(account)})`);
      if (args[1] && args[1] !== "google") throw new Error(`only \`auth google --account ${account}\` is supported (Google Health is single-account)`);
      const sources = parseGoogleSources(sourcesArg ?? process.env[`GOOGLE_SOURCES__${account}`]);
      if (!sources.length) throw new Error(`--sources must name at least one of gmail, calendar, youtube, meet`);
      console.log(`[Google ${account}: ${sources.join(", ")}] ブラウザで Google の同意画面を開きます（127.0.0.1:8789 で受け取ります）。そのアカウントでログインしてください…`);
      const { refreshToken, scopes } = await authorizeGoogle(process.env, { scopes: scopesFor(sources) });
      setEnvVar(ENV_FILE, `GOOGLE_REFRESH_TOKEN__${account}`, refreshToken);
      if (sourcesArg !== undefined) setEnvVar(ENV_FILE, `GOOGLE_SOURCES__${account}`, sources.join(","));
      console.log(`GOOGLE_REFRESH_TOKEN__${account}${sourcesArg !== undefined ? ` と GOOGLE_SOURCES__${account}` : ""} を ${ENV_FILE} に書き込みました。許可されたスコープ:\n  ${scopes.split(" ").join("\n  ")}`);
      return;
    }
    // Gmail / Calendar / YouTube (/ Meet when opted in) share one token; the Health API needs a token with health scopes only
    const targets = args[1] ? GOOGLE_TOKENS.filter((t) => t.name === args[1]) : [...GOOGLE_TOKENS];
    if (!targets.length) throw new Error(`usage: bun run collect auth [${GOOGLE_TOKENS.map((t) => t.name).join(" | ")}] [--sources gmail,calendar,youtube,meet] | auth google --account <name> [--sources …]`);
    for (const t of targets) {
      // the default account's GOOGLE_SOURCES (or --sources) narrows / widens the consent the same way as an extra account's
      const sourcesValue = t.name === "google" ? (sourcesArg ?? process.env.GOOGLE_SOURCES) : undefined;
      const scopes = sourcesValue ? scopesFor(parseGoogleSources(sourcesValue)) : [...t.scopes];
      if (!scopes.length) throw new Error(`--sources must name at least one of gmail, calendar, youtube, meet`);
      console.log(`[${t.label}${sourcesValue ? `: ${parseGoogleSources(sourcesValue).join(", ")}` : ""}] ブラウザで Google の同意画面を開きます（127.0.0.1:8789 で受け取ります）…`);
      const { refreshToken, scopes: granted } = await authorizeGoogle(process.env, { scopes });
      setEnvVar(ENV_FILE, t.envVar, refreshToken);
      if (t.name === "google" && sourcesArg !== undefined) setEnvVar(ENV_FILE, "GOOGLE_SOURCES", parseGoogleSources(sourcesArg).join(","));
      console.log(`${t.envVar} を ${ENV_FILE} に書き込みました。許可されたスコープ:\n  ${granted.split(" ").join("\n  ")}`);
    }
    return;
  }

  const cfg = loadConfig();
  if (args[0] === "status") {
    const state = loadState(cfg);
    const instances = collectorInstances(COLLECTORS, process.env);
    const width = Math.max(9, ...instances.map((i) => i.id.length));
    for (const { id, collector: c, env } of instances) {
      const ok = c.configured(env);
      const st = state[id];
      console.log(`${id.padEnd(width)} ${ok === true ? "configured" : `skipped: ${ok}`}${st?.lastRunAt ? ` | last run ${st.lastRunAt}` : ""}${st?.lastTo ? ` | collected to ${st.lastTo.slice(0, 10)}` : ""}${st?.lastError ? ` | last error: ${st.lastError}` : ""}`);
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
  // only a refused credential is worth a notification: everything else is in the log and the morning digest
  const warnings = authFailures(reports, process.env);
  for (const w of warnings) console.log(`  WARN ${w}`);
  if (warnings.length && !dryRun) notify(warnings.join("\n"));
  if (reports.some((r) => r.status === "failed")) process.exitCode = 1;
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
