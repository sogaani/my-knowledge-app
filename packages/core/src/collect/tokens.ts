/**
 * The collector's credentials and how an authentication failure is told apart from any other error.
 * No expiry is tracked: the Google refresh tokens do not expire (consent screen published to production) and the
 * GitHub PAT's date is GitHub's to announce by mail. A source that fails because its credential was refused
 * (Google invalid_grant, GitHub 401) is an auth failure: the daily run sends a macOS notification naming the
 * credential and how to renew it, and the morning ops digest marks the source as 認証失敗.
 */
import { githubAccounts, googleAccounts, googleSourcesOf, instanceId } from "./accounts";
import { GOOGLE_TOKENS, isExpiredTokenError } from "./google";
import type { Env } from "./types";

export interface Credential {
  id: string;
  label: string;
  envVar: string;
  /** Collector ids that authenticate with it. */
  sources: string[];
  /** What to do to renew. */
  renew: string;
}

const GOOGLE_SOURCES: Record<(typeof GOOGLE_TOKENS)[number]["name"], string[]> = {
  google: ["gmail", "gmail-review", "calendar", "youtube", "meet"],
  "google-health": ["health"],
};

/** The default account's credentials. */
export const CREDENTIALS: Credential[] = [
  ...GOOGLE_TOKENS.map((t) => ({ id: t.name, label: t.label, envVar: t.envVar, sources: GOOGLE_SOURCES[t.name], renew: `bun run collect auth ${t.name}` })),
  { id: "github", label: "GitHub PAT", envVar: "GITHUB_TOKEN", sources: ["github"], renew: "GitHub で再生成して GITHUB_TOKEN を書き換える" },
];

/** The default account's credentials plus one per extra Google / GitHub account found in the env (accounts.ts). */
export function credentials(env: Env): Credential[] {
  return [
    ...CREDENTIALS,
    ...googleAccounts(env).map((a) => ({
      id: `google@${a}`, label: `Google ${a}`, envVar: `GOOGLE_REFRESH_TOKEN__${a}`,
      sources: googleSourcesOf(env, a).map((s) => instanceId(s, a)), renew: `bun run collect auth google --account ${a}`,
    })),
    ...githubAccounts(env).map((a) => ({
      id: `github@${a}`, label: `GitHub PAT ${a}`, envVar: `GITHUB_TOKEN__${a}`, sources: [instanceId("github", a)],
      renew: `GitHub で再生成して GITHUB_TOKEN__${a} を書き換える`,
    })),
  ];
}

/** A source error that means the credential was refused: Google's invalid_grant (revoked / consent withdrawn) or a 401. */
export const isAuthError = (msg: string) => isExpiredTokenError(msg) || /\bHTTP 401\b|bad credentials/i.test(msg);

/** One line per credential whose sources failed to authenticate in this run; nothing for any other failure. */
export function authFailures(reports: { id: string; status: string; reason?: string }[], env: Env = {}): string[] {
  const out: string[] = [];
  for (const c of credentials(env)) {
    const failed = reports.filter((r) => r.status === "failed" && c.sources.includes(r.id) && isAuthError(r.reason ?? ""));
    if (failed.length) out.push(`${c.label} の認証に失敗しました（${failed.map((r) => r.id).join(", ")}）。${c.renew}`);
  }
  return out;
}
