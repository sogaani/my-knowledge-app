#!/usr/bin/env bun
/**
 * Bronze collectors (Mac): pull GitHub / Gmail / Calendar / YouTube / Google Health / LinkedIn export into 000_inbox.
 *   bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *   bun run collect status
 *   bun run collect auth google
 * Logic lives in @kb/core (collect/); this is the entry point that owns the .env with the secrets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTORS, authorizeGoogle, loadConfig, loadState, runCollectors } from "@kb/core";

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
    if (args[1] !== "google") throw new Error("usage: bun run collect auth google");
    console.log("ブラウザで Google の同意画面を開きます（127.0.0.1:8789 で受け取ります）…");
    const { scopes } = await authorizeGoogle(process.env).then((r) => { setEnvVar("GOOGLE_REFRESH_TOKEN", r.refreshToken); return r; });
    console.log(`GOOGLE_REFRESH_TOKEN を ${ENV_FILE} に書き込みました。許可されたスコープ:\n  ${scopes.split(" ").join("\n  ")}`);
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
  if (reports.some((r) => r.status === "failed")) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`collect: ${(e as Error).message ?? e}`);
  process.exit(1);
});
