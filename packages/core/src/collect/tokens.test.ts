import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureEnvFile, setEnvVar } from "./envfile";
import { CREDENTIALS, authFailures, credentials, isAuthError } from "./tokens";
import { accountEnv, accountFileName, collectorInstances, googleAccounts, parseGoogleSources, scopesFor, splitId } from "./accounts";
import type { Collector } from "./types";

// fixture values only: nothing here is a real token

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
    setEnvVar(file, "GITHUB_LOGIN", "me");
    expect(readFileSync(file, "utf8")).toBe("# comment\nKB_ROOT=/x\nGITHUB_TOKEN=new\nGITHUB_LOGIN=me\n");
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

describe("auth failures", () => {
  test("a refused credential is told apart from every other error", () => {
    expect(isAuthError("GOOGLE_REFRESH_TOKEN expired or revoked (invalid_grant): run bun run collect auth google")).toBe(true);
    expect(isAuthError('HTTP 401 https://api.github.com/user: {"message":"Bad credentials"}')).toBe(true);
    expect(isAuthError("HTTP 403 https://www.googleapis.com/gmail/v1/users/me/messages: quota")).toBe(false);
    expect(isAuthError("HTTP 500 https://api.github.com/user")).toBe(false);
    expect(isAuthError("every feed failed")).toBe(false);
  });

  test("every collector that needs a credential is mapped to exactly one", () => {
    const ids = CREDENTIALS.flatMap((c) => c.sources);
    expect(ids.sort()).toEqual(["calendar", "github", "gmail", "gmail-review", "health", "meet", "slack", "youtube"]);
  });

  test("one warning per credential, naming the sources that failed; other failures are silent", () => {
    const reports = [
      { id: "gmail", status: "failed", reason: "GOOGLE_REFRESH_TOKEN expired or revoked (invalid_grant): run bun run collect auth google" },
      { id: "calendar", status: "failed", reason: "GOOGLE_REFRESH_TOKEN expired or revoked (invalid_grant): run bun run collect auth google" },
      { id: "youtube", status: "failed", reason: "HTTP 403 https://www.googleapis.com/youtube/v3/playlistItems: quotaExceeded" },
      { id: "health", status: "ok" },
      { id: "github", status: "failed", reason: 'HTTP 401 https://api.github.com/user: {"message":"Bad credentials"}' },
      { id: "rss", status: "failed", reason: "every feed failed" },
    ];
    expect(authFailures(reports)).toEqual([
      "Gmail / Calendar / YouTube の認証に失敗しました（gmail, calendar）。bun run collect auth google",
      "GitHub PAT の認証に失敗しました（github）。GitHub で再生成して GITHUB_TOKEN を書き換える",
    ]);
    expect(authFailures([{ id: "gmail", status: "ok" }, { id: "rss", status: "failed", reason: "every feed failed" }])).toEqual([]);
    // a skipped (unconfigured) source is not a failure
    expect(authFailures([{ id: "health", status: "skipped", reason: "missing GOOGLE_HEALTH_REFRESH_TOKEN" }])).toEqual([]);
  });

  test("an extra account is one more credential, covering only the sources it runs", () => {
    const env = { GOOGLE_REFRESH_TOKEN: "a", GOOGLE_REFRESH_TOKEN__work: "b", GOOGLE_SOURCES__work: "gmail,calendar", GITHUB_TOKEN__work: "t" };
    const extra = credentials(env).slice(CREDENTIALS.length);
    expect(extra.map((c) => [c.id, c.envVar, c.sources])).toEqual([
      ["google@work", "GOOGLE_REFRESH_TOKEN__work", ["gmail@work", "gmail-review@work", "calendar@work"]],
      ["github@work", "GITHUB_TOKEN__work", ["github@work"]],
    ]);
    const reports = [
      { id: "gmail", status: "ok" },
      { id: "gmail@work", status: "failed", reason: "GOOGLE_REFRESH_TOKEN__work expired or revoked (invalid_grant): run bun run collect auth google --account work" },
      { id: "github@work", status: "failed", reason: 'HTTP 401 https://api.github.com/user: {"message":"Bad credentials"}' },
    ];
    expect(authFailures(reports, env)).toEqual([
      "Google work の認証に失敗しました（gmail@work）。bun run collect auth google --account work",
      "GitHub PAT work の認証に失敗しました（github@work）。GitHub で再生成して GITHUB_TOKEN__work を書き換える",
    ]);
    expect(authFailures(reports)).toEqual([]); // without the env the extra accounts are unknown
  });
});

describe("accounts", () => {
  test("ids and file names: the account goes after the source id, and before the extension", () => {
    expect(splitId("calendar@work")).toEqual({ id: "calendar", account: "work" });
    expect(splitId("gmail-review")).toEqual({ id: "gmail-review" });
    expect(accountFileName("collect-calendar-2026-10-27_2026-11-03.json", "work")).toBe("collect-calendar-2026-10-27_2026-11-03@work.json");
    expect(accountFileName("mail-20261103-purchase-18f3a.json", "work")).toBe("mail-20261103-purchase-18f3a@work.json");
    expect(accountFileName("mail-20261103-purchase-18f3a.json")).toBe("mail-20261103-purchase-18f3a.json");
    // ingest routes by these patterns; an account suffix must not disturb them
    expect(/^mail-\d{8}-([a-z]+)-/.exec("mail-20261103-purchase-18f3a@work.json")?.[1]).toBe("purchase");
    expect(/^collect-calendar-.*\.json$/.test("collect-calendar-2026-10-27_2026-11-03@work.json")).toBe(true);
    expect("mail-20261103-purchase-18f3a@work.json").not.toMatch(/-work-/); // not the KB/作業 category
  });

  test("account env: KEY__<name> under the plain name, the default account's per-account values cleared, shared ones kept", () => {
    const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_REFRESH_TOKEN: "a", GOOGLE_CALENDAR_IDS: "mine", GMAIL: "off", GOOGLE_REFRESH_TOKEN__work: "b", GITHUB_TOKEN__work: "t", GITHUB_LOGIN__work: "me-work", FEED_URLS: "u" };
    expect(accountEnv(env, "work")).toMatchObject({ GOOGLE_CLIENT_ID: "c", GOOGLE_REFRESH_TOKEN: "b", GOOGLE_CALENDAR_IDS: undefined, GMAIL: undefined, GITHUB_TOKEN: "t", GITHUB_LOGIN: "me-work", FEED_URLS: "u" });
    expect(accountEnv(env)).toBe(env);
    expect(googleAccounts({ GOOGLE_REFRESH_TOKEN__work: "b", GOOGLE_REFRESH_TOKEN__Bad_Name: "x", GOOGLE_REFRESH_TOKEN__empty: "", GOOGLE_REFRESH_TOKEN__alt: "c" })).toEqual(["alt", "work"]);
  });

  test("GOOGLE_SOURCES: gmail brings gmail-review, unknown names dropped, unset = all; scopes follow", () => {
    expect(parseGoogleSources("gmail,calendar")).toEqual(["gmail", "gmail-review", "calendar"]);
    expect(parseGoogleSources(" calendar , drive ")).toEqual(["calendar"]);
    expect(parseGoogleSources(undefined)).toEqual(["gmail", "gmail-review", "calendar", "youtube"]);
    expect(scopesFor(["gmail", "gmail-review", "calendar"])).toEqual(["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.readonly"]);
  });

  test("collectorInstances: default first, then each extra account that runs the source; health / rss stay single", () => {
    const stub = (id: string): Collector => ({ id, label: id, lookbackDays: 1, configured: () => true, collect: async () => ({}), digest: () => "" });
    const all = ["gmail", "gmail-review", "github", "calendar", "youtube", "health", "rss"].map(stub);
    const env = { GOOGLE_REFRESH_TOKEN__work: "b", GOOGLE_SOURCES__work: "calendar", GOOGLE_REFRESH_TOKEN__alt: "c", GITHUB_TOKEN__work: "t" };
    const inst = collectorInstances(all, env);
    expect(inst.map((i) => i.id)).toEqual(["gmail", "gmail@alt", "gmail-review", "gmail-review@alt", "github", "github@work", "calendar", "calendar@alt", "calendar@work", "youtube", "youtube@alt", "health", "rss"]);
    expect(inst.find((i) => i.id === "calendar@work")!.env.GOOGLE_REFRESH_TOKEN).toBe("b");
    expect(inst.find((i) => i.id === "github@work")!.env.GITHUB_TOKEN).toBe("t");
  });
});
