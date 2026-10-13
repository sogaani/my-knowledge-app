/**
 * GitHub, two feeds merged into one:
 * - search API (fine-grained read-only PAT): issues / PRs I created and commits I authored in the window. Commit
 *   search only indexes the default branch, so feature-branch work surfaces here only once merged.
 * - /users/:login/events (newest first, ≤300 events / ~30 days): pushes to any branch, pull request reviews and
 *   stars. With the token's "Events" user permission (read) private events are included, otherwise public only.
 *   The cursor is the newest event id seen; the first run takes the events created in the window.
 * A push's commits that the commit search already returned are dropped from the push (same run, by sha), so a
 * commit on the default branch is one item, and a push whose commits were all found that way is dropped.
 */
import type { Collector, CollectContext } from "../types";
import type { HttpClient } from "../http";

const API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 10; // search returns at most 1000 results anyway
const EVENT_PAGES = 3; // the events API serves at most 300 events

interface SearchPage<T> { total_count: number; incomplete_results: boolean; items: T[] }
interface IssueItem { html_url: string; title: string; number: number; state: string; created_at: string; closed_at: string | null; repository_url: string; pull_request?: unknown; labels?: { name: string }[] }
interface CommitItem { html_url: string; sha: string; commit: { message: string; author: { date: string } }; repository: { full_name: string } }

export interface PushCommit { sha: string; message: string; author?: { name?: string; email?: string }; distinct?: boolean }
export interface PushPayload { ref: string; head: string; before: string; size?: number; distinct_size?: number; commits: PushCommit[] }
export interface ReviewPayload { action: string; review: { state: string; html_url: string; submitted_at: string; body: string | null }; pull_request: { number: number; title: string; html_url: string } }
export interface WatchPayload { action: string }
export interface GitHubEvent<P = unknown> { id: string; type: string; public?: boolean; created_at: string; repo: { id?: number; name: string; url?: string }; payload: P }

export type Item =
  | { kind: "issue" | "pr"; repo: string; raw: IssueItem }
  | { kind: "commit"; repo: string; raw: CommitItem }
  | { kind: "push"; repo: string; raw: GitHubEvent<PushPayload>; commits: PushCommit[] }
  | { kind: "review"; repo: string; raw: GitHubEvent<ReviewPayload> }
  | { kind: "star"; repo: string; raw: GitHubEvent<WatchPayload> };

const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });

async function search<T>(http: HttpClient, token: string, path: "issues" | "commits", q: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await http.json<SearchPage<T>>(`${API}/search/${path}?${new URLSearchParams({ q, per_page: String(PER_PAGE), page: String(page), sort: path === "commits" ? "committer-date" : "created", order: "asc" })}`, { headers: headers(token) });
    out.push(...r.items);
    if (r.items.length < PER_PAGE) break;
  }
  return out;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 19) + "Z";

/** Event ids are decimal strings that only grow; compare them as numbers without losing digits. */
export const newerEventId = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a > b);

/** Whether an event is past the cursor (by id) — or, before the first cursor, inside the window. */
export const isNewEvent = (ev: GitHubEvent, cursor: string | undefined, from: Date) =>
  cursor ? newerEventId(ev.id, cursor) : Date.parse(ev.created_at) >= from.getTime();

/**
 * Pushes, reviews and stars out of a page of events (newest first → returned oldest first). `knownShas` are the
 * commits the search already returned; they are dropped from the push, and a push left with none is skipped.
 */
export function eventItems(events: GitHubEvent[], knownShas: Set<string>): Item[] {
  const seen = new Set(knownShas);
  const out: Item[] = [];
  for (const ev of [...events].reverse()) {
    const repo = ev.repo.name;
    if (ev.type === "PushEvent") {
      const push = ev as GitHubEvent<PushPayload>;
      const commits = (push.payload.commits ?? []).filter((c) => !seen.has(c.sha));
      for (const c of commits) seen.add(c.sha);
      if (commits.length) out.push({ kind: "push", repo, raw: push, commits });
    } else if (ev.type === "PullRequestReviewEvent") {
      out.push({ kind: "review", repo, raw: ev as GitHubEvent<ReviewPayload> });
    } else if (ev.type === "WatchEvent") {
      out.push({ kind: "star", repo, raw: ev as GitHubEvent<WatchPayload> });
    }
  }
  return out;
}

async function fetchEvents(http: HttpClient, token: string, login: string, cursor: string | undefined, from: Date): Promise<GitHubEvent[]> {
  const out: GitHubEvent[] = [];
  for (let page = 1; page <= EVENT_PAGES; page++) {
    const r = await http.json<GitHubEvent[]>(`${API}/users/${encodeURIComponent(login)}/events?${new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })}`, { headers: headers(token) });
    const fresh = r.filter((ev) => isNewEvent(ev, cursor, from));
    out.push(...fresh);
    if (fresh.length < r.length || r.length < PER_PAGE) break; // reached the cursor / window start, or the last page
  }
  return out;
}

export const github: Collector = {
  id: "github",
  label: "GitHub",
  lookbackDays: 7,
  configured: (env) => (env.GITHUB_TOKEN ? true : "missing GITHUB_TOKEN"),
  async collect({ env, http, from, to, cursor }: CollectContext) {
    const token = env.GITHUB_TOKEN!;
    const login = env.GITHUB_LOGIN || (await http.json<{ login: string }>(`${API}/user`, { headers: headers(token) })).login;
    const range = `${isoDate(from)}..${isoDate(to)}`;
    // the issues endpoint requires is:issue or is:pull-request in the query
    const [issues, prs, commits, events] = await Promise.all([
      search<IssueItem>(http, token, "issues", `is:issue author:${login} created:${range}`),
      search<IssueItem>(http, token, "issues", `is:pull-request author:${login} created:${range}`),
      search<CommitItem>(http, token, "commits", `author:${login} committer-date:${range}`),
      fetchEvents(http, token, login, cursor, from),
    ]);
    const repoOf = (url: string) => url.replace(`${API}/repos/`, "");
    const items: Item[] = [
      ...[...issues, ...prs].map((raw) => ({ kind: raw.pull_request ? ("pr" as const) : ("issue" as const), repo: repoOf(raw.repository_url), raw })),
      ...commits.map((raw) => ({ kind: "commit" as const, repo: raw.repository.full_name, raw })),
      ...eventItems(events, new Set(commits.map((c) => c.sha))),
    ];
    const newest = events.reduce<string | undefined>((best, ev) => (best && !newerEventId(ev.id, best) ? best : ev.id), undefined);
    return { items, meta: { login, events: events.length }, cursor: newest ?? cursor };
  },
  digest(item) {
    const it = item as Item;
    const day = (s: string) => s.slice(0, 10);
    const first = (msg: string) => msg.split("\n")[0]!;
    switch (it.kind) {
      case "commit": return `${day(it.raw.commit.author.date)} commit ${it.repo} ${it.raw.sha.slice(0, 7)} ${first(it.raw.commit.message)}`;
      case "push": {
        const branch = it.raw.payload.ref.replace(/^refs\/heads\//, "");
        const msgs = it.commits.slice(0, 3).map((c) => `${c.sha.slice(0, 7)} ${first(c.message)}`).join("; ");
        return `${day(it.raw.created_at)} push ${it.repo} ${branch} (${it.commits.length} commits) ${msgs}${it.commits.length > 3 ? "; …" : ""}`;
      }
      case "review": return `${day(it.raw.payload.review.submitted_at ?? it.raw.created_at)} review ${it.repo}#${it.raw.payload.pull_request.number} [${it.raw.payload.review.state}] ${it.raw.payload.pull_request.title}`;
      case "star": return `${day(it.raw.created_at)} star ${it.repo} https://github.com/${it.repo}`;
      default: return `${day(it.raw.created_at)} ${it.kind} ${it.repo}#${it.raw.number} [${it.raw.state}] ${it.raw.title}`;
    }
  },
};
