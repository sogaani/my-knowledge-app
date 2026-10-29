import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureEnvFile, setEnvVar } from "./envfile";
import { CREDENTIALS, authFailures, isAuthError } from "./tokens";

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
    expect(ids.sort()).toEqual(["calendar", "github", "gmail", "gmail-review", "health", "youtube"]);
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
});
