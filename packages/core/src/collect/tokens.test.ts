import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { secureEnvFile, setEnvVar } from "./envfile";
import { GITHUB_WARN_DAYS, githubTokenExpiry, loadTokenDays, saveTokenExpiries, tokenStatuses, tokenWarnings, tokensPath } from "./tokens";

// fixture values only: nothing here is a real token
const NOW = new Date(2026, 9, 14, 7, 0); // local 2026-10-14 07:00

describe("env file", () => {
  test("setEnvVar replaces in place, appends when missing, and always leaves the file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "# comment\nKB_ROOT=/x\nGITHUB_TOKEN=old\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    setEnvVar(file, "GITHUB_TOKEN", "new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("# comment\nKB_ROOT=/x\nGITHUB_TOKEN=new\n");
    setEnvVar(file, "GITHUB_TOKEN_EXPIRES", "2026-12-31");
    expect(readFileSync(file, "utf8")).toBe("# comment\nKB_ROOT=/x\nGITHUB_TOKEN=new\nGITHUB_TOKEN_EXPIRES=2026-12-31\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  test("setEnvVar creates a missing file with 0600; secureEnvFile tightens an open one and reports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-env-"));
    const file = join(dir, ".env");
    setEnvVar(file, "KB_ROOT", "/x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(secureEnvFile(file)).toBe(false);
    chmodSync(file, 0o644);
    expect(secureEnvFile(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(secureEnvFile(join(dir, "missing"))).toBe(false);
  });
});

describe("token lifetimes", () => {
  test("GITHUB_TOKEN_EXPIRES is a local date; malformed or missing tracks nothing", () => {
    const e = githubTokenExpiry({ GITHUB_TOKEN_EXPIRES: "2026-10-24" }, NOW);
    expect(e.expiresAt).toEqual(new Date(2026, 9, 24));
    expect(e.daysLeft).toBeCloseTo(9.708, 2);
    expect(githubTokenExpiry({ GITHUB_TOKEN_EXPIRES: "24/10/2026" }, NOW)).toEqual({});
    expect(githubTokenExpiry({ GITHUB_TOKEN_EXPIRES: "2026-13-40" }, NOW).expiresAt).toBeUndefined();
    expect(githubTokenExpiry({}, NOW)).toEqual({});
  });

  test("statuses cover both Google tokens and the GitHub PAT, configured or not", () => {
    const env = {
      GOOGLE_REFRESH_TOKEN: "g", GOOGLE_REFRESH_TOKEN_ISSUED_AT: new Date(NOW.getTime() - 6 * 86_400_000).toISOString(),
      GITHUB_TOKEN: "h", GITHUB_TOKEN_EXPIRES: "2027-01-01",
    };
    const s = tokenStatuses(env, NOW);
    expect(s.map((t) => [t.id, t.configured])).toEqual([["google", true], ["google-health", false], ["github", true]]);
    expect(s[0]!.daysLeft).toBeCloseTo(1, 5);
    expect(s[1]!.daysLeft).toBeUndefined();
    expect(s[2]!.daysLeft).toBeGreaterThan(70);
    expect(s[2]!.warnDays).toBe(GITHUB_WARN_DAYS);
    // no expiry date recorded: configured but untracked
    expect(tokenStatuses({ GITHUB_TOKEN: "h" }, NOW)[2]!.expiresAt).toBeUndefined();
  });

  test("warnings: within warnDays, expired, dead by error; silent otherwise", () => {
    const issued = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
    const fmt = (d: Date) => d.toISOString();
    // Google at 5.6 days (1.4 left) warns, GitHub 6 days out warns, Health is fine
    let w = tokenWarnings(tokenStatuses({
      GOOGLE_REFRESH_TOKEN: "g", GOOGLE_REFRESH_TOKEN_ISSUED_AT: issued(5.6),
      GOOGLE_HEALTH_REFRESH_TOKEN: "x", GOOGLE_HEALTH_REFRESH_TOKEN_ISSUED_AT: issued(1),
      GITHUB_TOKEN: "h", GITHUB_TOKEN_EXPIRES: "2026-10-20",
    }, NOW), () => false, fmt);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^Gmail \/ Calendar \/ YouTube のトークンは .* に切れます（残り 1\.4 日）。bun run collect auth google$/);
    expect(w[1]).toMatch(/^GitHub PAT のトークンは .* に切れます（残り 5\.7 日）。GitHub で再生成/);
    // Google at 2 days left and GitHub at 8 days: quiet
    w = tokenWarnings(tokenStatuses({ GOOGLE_REFRESH_TOKEN: "g", GOOGLE_REFRESH_TOKEN_ISSUED_AT: issued(5), GITHUB_TOKEN: "h", GITHUB_TOKEN_EXPIRES: "2026-10-22" }, NOW), () => false, fmt);
    expect(w).toEqual([]);
    // expired by date, and dead by a source error even though the date says it is fine
    w = tokenWarnings(tokenStatuses({ GOOGLE_REFRESH_TOKEN: "g", GOOGLE_REFRESH_TOKEN_ISSUED_AT: issued(7.5), GITHUB_TOKEN: "h", GITHUB_TOKEN_EXPIRES: "2026-10-01", GOOGLE_HEALTH_REFRESH_TOKEN: "x", GOOGLE_HEALTH_REFRESH_TOKEN_ISSUED_AT: issued(1) }, NOW), (s) => s.id === "google-health", fmt);
    expect(w).toEqual([
      "Gmail / Calendar / YouTube のトークンが切れました。bun run collect auth google",
      "Google Health のトークンが切れました。bun run collect auth google-health",
      "GitHub PAT のトークンが切れました。GitHub で再生成して GITHUB_TOKEN と GITHUB_TOKEN_EXPIRES を書き換える",
    ]);
    // unconfigured and unknown-expiry tokens never warn
    expect(tokenWarnings(tokenStatuses({ GITHUB_TOKEN: "h" }, NOW), () => false, fmt)).toEqual([]);
  });

  test("the collector hands expiry dates (no values) to the digest; days left are computed when read", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-tokens-"));
    writeFileSync(join(root, "AGENTS.md"), "");
    const cfg = loadConfig(root);
    expect(loadTokenDays(cfg, NOW)).toEqual([]);
    const statuses = tokenStatuses({
      GOOGLE_REFRESH_TOKEN: "g", GOOGLE_REFRESH_TOKEN_ISSUED_AT: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      GITHUB_TOKEN: "h", GITHUB_TOKEN_EXPIRES: "2026-11-13",
      GOOGLE_HEALTH_REFRESH_TOKEN: "x", // no issue date → stored with expiresAt null, skipped on read
    }, NOW);
    saveTokenExpiries(cfg, statuses, NOW);
    const file = readFileSync(tokensPath(cfg), "utf8");
    expect(file).not.toContain('"g"');
    expect(file).not.toContain("GOOGLE_REFRESH_TOKEN");
    const days = loadTokenDays(cfg, new Date(NOW.getTime() + 86_400_000));
    expect(days.map((d) => [d.id, Math.round(d.daysLeft * 10) / 10])).toEqual([["google", 3], ["github", 28.7]]);
    writeFileSync(tokensPath(cfg), "{not json");
    expect(loadTokenDays(cfg, NOW)).toEqual([]);
  });
});
