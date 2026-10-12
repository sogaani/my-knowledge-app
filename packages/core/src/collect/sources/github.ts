/** GitHub: issues / PRs I created and commits I authored in the window (search API, fine-grained read-only PAT). */
import type { Collector, CollectContext } from "../types";
import type { HttpClient } from "../http";

const API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 10; // search returns at most 1000 results anyway

interface SearchPage<T> { total_count: number; incomplete_results: boolean; items: T[] }
interface IssueItem { html_url: string; title: string; number: number; state: string; created_at: string; closed_at: string | null; repository_url: string; pull_request?: unknown; labels?: { name: string }[] }
interface CommitItem { html_url: string; sha: string; commit: { message: string; author: { date: string } }; repository: { full_name: string } }

type Item =
  | { kind: "issue" | "pr"; repo: string; raw: IssueItem }
  | { kind: "commit"; repo: string; raw: CommitItem };

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

export const github: Collector = {
  id: "github",
  label: "GitHub",
  lookbackDays: 7,
  configured: (env) => (env.GITHUB_TOKEN ? true : "missing GITHUB_TOKEN"),
  async collect({ env, http, from, to }: CollectContext) {
    const token = env.GITHUB_TOKEN!;
    const login = env.GITHUB_LOGIN || (await http.json<{ login: string }>(`${API}/user`, { headers: headers(token) })).login;
    const range = `${isoDate(from)}..${isoDate(to)}`;
    const [issues, commits] = await Promise.all([
      search<IssueItem>(http, token, "issues", `author:${login} created:${range}`),
      search<CommitItem>(http, token, "commits", `author:${login} committer-date:${range}`),
    ]);
    const repoOf = (url: string) => url.replace(`${API}/repos/`, "");
    const items: Item[] = [
      ...issues.map((raw) => ({ kind: raw.pull_request ? ("pr" as const) : ("issue" as const), repo: repoOf(raw.repository_url), raw })),
      ...commits.map((raw) => ({ kind: "commit" as const, repo: raw.repository.full_name, raw })),
    ];
    return { items, meta: { login } };
  },
  digest(item) {
    const it = item as Item;
    if (it.kind === "commit") return `${it.raw.commit.author.date.slice(0, 10)} commit ${it.repo} ${it.raw.sha.slice(0, 7)} ${it.raw.commit.message.split("\n")[0]}`;
    return `${it.raw.created_at.slice(0, 10)} ${it.kind} ${it.repo}#${it.raw.number} [${it.raw.state}] ${it.raw.title}`;
  },
};
