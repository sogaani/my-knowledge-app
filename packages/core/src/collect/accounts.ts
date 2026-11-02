/**
 * Extra accounts for the Google and GitHub sources.
 *
 * The default account's credentials are the plain variables (GOOGLE_REFRESH_TOKEN, GITHUB_TOKEN, …). A second
 * account named <name> ([a-z0-9]+) puts the same variables with a `__<name>` suffix in the .env:
 *   GOOGLE_REFRESH_TOKEN__work  GOOGLE_SOURCES__work=gmail,calendar  GOOGLE_CALENDAR_IDS__work  GMAIL_REVIEW__work=off
 *   GITHUB_TOKEN__work  GITHUB_LOGIN__work
 * Every account runs its own instance of each source: id `calendar@work`, state key `calendar@work`, inbox files
 * `collect-calendar-<from>_<to>@work.json` / `mail-<date>-<category>-<id>@work.json` (the account goes before the
 * extension so the `collect-<source>-*` / `mail-*-<category>-*` patterns ingest routes by keep matching), and the
 * envelope / mail JSON carries `account`. Shared settings (the OAuth client, FEED_URLS) are not per account.
 * Google Health stays single-account: the monthly health_log sums its numbers and two accounts would double count.
 */
import type { Collector, Env } from "./types";

export const ACCOUNT_RE = /^[a-z0-9]+$/;

/** Sources a Google account can run (GOOGLE_SOURCES / GOOGLE_SOURCES__<name>; `gmail` brings `gmail-review` along). */
export const GOOGLE_ACCOUNT_SOURCES = ["gmail", "gmail-review", "calendar", "youtube", "meet"] as const;
export type GoogleAccountSource = (typeof GOOGLE_ACCOUNT_SOURCES)[number];
/** What an unset GOOGLE_SOURCES means: the classic four. `meet` is opt-in (extra scope, usually a work account). */
export const DEFAULT_GOOGLE_SOURCES: GoogleAccountSource[] = ["gmail", "gmail-review", "calendar", "youtube"];

/** Consent scope each Google source needs (a consent only asks for the scopes of the sources the account runs). */
export const GOOGLE_SOURCE_SCOPES: Record<GoogleAccountSource, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  "gmail-review": "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  meet: "https://www.googleapis.com/auth/meetings.space.readonly",
};

/** Per-account variables: for account <name> they come from KEY__<name>; the default account's value is not inherited. */
export const ACCOUNT_KEYS = [
  "GOOGLE_REFRESH_TOKEN", "GOOGLE_SOURCES", "GOOGLE_CALENDAR_IDS", "GOOGLE_CALENDAR_HORIZON_DAYS", "YOUTUBE_PLAYLIST_IDS", "GMAIL", "GMAIL_REVIEW",
  "GITHUB_TOKEN", "GITHUB_LOGIN",
] as const;

export const instanceId = (id: string, account?: string) => (account ? `${id}@${account}` : id);

/** `calendar@work` → { id: "calendar", account: "work" }; `calendar` → { id: "calendar" }. */
export function splitId(iid: string): { id: string; account?: string } {
  const i = iid.indexOf("@");
  return i < 0 ? { id: iid } : { id: iid.slice(0, i), account: iid.slice(i + 1) };
}

/** `collect-calendar-a_b.json` + work → `collect-calendar-a_b@work.json`. */
export const accountFileName = (name: string, account?: string) => (account ? name.replace(/(\.[a-z0-9]+)?$/i, `@${account}$1`) : name);

/** The env an account's sources see: its own KEY__<name> values under the plain names, the default account's cleared. */
export function accountEnv(env: Env, account?: string): Env {
  if (!account) return env;
  const out: Env = { ...env };
  for (const k of ACCOUNT_KEYS) out[k] = env[`${k}__${account}`];
  return out;
}

const accountsWith = (env: Env, key: string) =>
  Object.keys(env)
    .map((k) => (k.startsWith(`${key}__`) ? k.slice(key.length + 2) : ""))
    .filter((a) => ACCOUNT_RE.test(a) && env[`${key}__${a}`])
    .sort();

/** Names of the extra Google accounts (those with a GOOGLE_REFRESH_TOKEN__<name>). */
export const googleAccounts = (env: Env) => accountsWith(env, "GOOGLE_REFRESH_TOKEN");
/** Names of the extra GitHub accounts (those with a GITHUB_TOKEN__<name>). */
export const githubAccounts = (env: Env) => accountsWith(env, "GITHUB_TOKEN");

/** Parse a GOOGLE_SOURCES value (`gmail,calendar,meet`): unknown names dropped, `gmail` adds `gmail-review`, unset = the classic four. */
export function parseGoogleSources(value: string | undefined): GoogleAccountSource[] {
  if (!value?.trim()) return [...DEFAULT_GOOGLE_SOURCES];
  const set = new Set(value.split(",").map((s) => s.trim()).filter((s): s is GoogleAccountSource => (GOOGLE_ACCOUNT_SOURCES as readonly string[]).includes(s)));
  if (set.has("gmail")) set.add("gmail-review");
  return GOOGLE_ACCOUNT_SOURCES.filter((s) => set.has(s));
}

/** The Google sources an extra account runs (GOOGLE_SOURCES__<name>, default: the classic four). */
export const googleSourcesOf = (env: Env, account: string) => parseGoogleSources(env[`GOOGLE_SOURCES__${account}`]);

/** Scopes to ask for at consent, for the sources an account runs. */
export const scopesFor = (sources: GoogleAccountSource[]) => [...new Set(sources.map((s) => GOOGLE_SOURCE_SCOPES[s]))];

/** One source run against one account. The default account keeps the plain id and env. */
export interface CollectorInstance {
  id: string;
  account?: string;
  collector: Collector;
  env: Env;
}

/**
 * Every (source, account) pair to run, in registry order: a source's default instance, then the same source for each
 * extra account that runs it. Health, LinkedIn and RSS have no account dimension.
 */
export function collectorInstances(all: Collector[], env: Env): CollectorInstance[] {
  const google = googleAccounts(env).map((a) => ({ account: a, sources: googleSourcesOf(env, a) as string[] }));
  const github = githubAccounts(env);
  const out: CollectorInstance[] = [];
  for (const c of all) {
    out.push({ id: c.id, collector: c, env });
    const accounts = c.id === "github" ? github : (GOOGLE_ACCOUNT_SOURCES as readonly string[]).includes(c.id) ? google.filter((g) => g.sources.includes(c.id)).map((g) => g.account) : [];
    for (const a of accounts) out.push({ id: instanceId(c.id, a), account: a, collector: c, env: accountEnv(env, a) });
  }
  return out;
}
