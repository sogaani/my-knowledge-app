/**
 * RSS / Atom feeds listed in FEED_URLS (comma / whitespace separated). One inbox file per feed that has new entries:
 * collect-rss-<slug>-<from>_<to>.json, items = title / url / date / the head of the summary (no full bodies — the
 * curate step judges from the head alone). When a feed's summary is thin (Hacker News gives "Comments"), the head of
 * the article page itself is fetched instead (`summary_source: "page"`), within a per-run budget. The cursor keeps the entry ids seen per feed, so an entry
 * is reported once even when the feed re-orders or re-dates it. Parsed with a few regexes: RSS 2.0, RSS 1.0 (RDF)
 * and Atom as the usual blog / news feeds emit them, nothing fancier.
 */
import { ymd } from "../dates";
import { mapLimit, type HttpClient } from "../http";
import type { Collector, Feed, InboxFile, Logger } from "../types";

const SEEN_MAX = 500; // ids kept per feed in the cursor
const FIRST_RUN_MAX = 50; // entries without a date on the first run
export const SUMMARY_CHARS = 300;
/** A feed summary shorter than this (or a stock phrase such as Hacker News's "Comments") says nothing: the page's own head is fetched instead. */
export const THIN_SUMMARY_CHARS = 40;
/** Pages fetched per run at most (the curate step reads only the head, so a few feeds' worth is enough), and how many at once. */
const PAGE_FETCH_MAX = 40;
const PAGE_FETCH_CONCURRENCY = 4;
const PAGE_BYTES_MAX = 600_000;

/** `summary_source: "page"` = the summary is the head of the article page, fetched because the feed's own was thin. */
export interface RssEntry { id: string; title: string; url: string; date: string | null; summary: string; author?: string; summary_source?: "page" }
export interface ParsedFeed { title: string; link?: string; kind: "rss" | "atom"; entries: RssEntry[] }
export interface FeedTarget { url: string; slug: string }

interface Cursor { v: 1; feeds: Record<string, string[]> }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const unwrapCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner);
/** Text of an HTML-ish value: CDATA unwrapped, escaped HTML (Atom type="html") unescaped, tags dropped, entities decoded. */
export const stripTags = (s: string) => decodeEntities(decodeEntities(unwrapCdata(s)).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** Element text: CDATA unwrapped, entities decoded, whitespace collapsed (tags, if any, are left — use stripTags). */
const text = (s: string) => decodeEntities(unwrapCdata(s)).replace(/\s+/g, " ").trim();
const esc = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Inner XML of the first <name> (optionally namespaced, with attributes) in `block`. */
export function tagText(block: string, name: string): string | undefined {
  const m = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, "i").exec(block);
  return m ? m[1] : undefined;
}
function firstTag(block: string, names: string[]): string | undefined {
  for (const n of names) { const v = tagText(block, n); if (v !== undefined && v.trim()) return v; }
  return undefined;
}
/** `attr` of each <name …> (self-closing or not) in order of appearance. */
function tagAttrs(block: string, name: string, attr: string): { value: string; rel?: string }[] {
  const out: { value: string; rel?: string }[] = [];
  const re = new RegExp(`<${esc(name)}\\s([^>]*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const attrs = m[1]!;
    const get = (a: string) => new RegExp(`\\b${esc(a)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
    const v = get(attr);
    if (v) out.push({ value: decodeEntities(v[1] ?? v[2] ?? ""), rel: get("rel")?.[1] ?? get("rel")?.[2] });
  }
  return out;
}

const isoOrNull = (s: string | undefined) => { const t = s ? Date.parse(text(s)) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };

function atomLink(block: string): string {
  const links = tagAttrs(block, "link", "href");
  return (links.find((l) => l.rel === "alternate") ?? links.find((l) => !l.rel) ?? links[0])?.value ?? "";
}

/** RSS 2.0 / RSS 1.0 (`<item>`) or Atom (`<entry>`) → entries in document order. Throws when it is neither. */
export function parseFeed(xml: string): ParsedFeed {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const atom = /<feed[\s>]/i.test(body) && !/<rss[\s>]|<rdf:RDF[\s>]/i.test(body);
  const entryRe = atom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  if (!atom && !/<rss[\s>]|<rdf:RDF[\s>]|<channel[\s>]/i.test(body)) throw new Error("not an RSS or Atom feed");
  const head = body.replace(entryRe, "");
  const title = stripTags(firstTag(head, ["title"]) ?? "");
  const link = atom ? atomLink(head) : text(firstTag(head, ["link"]) ?? "");
  const entries: RssEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body))) {
    const b = m[1]!;
    const url = atom ? atomLink(b) : text(firstTag(b, ["link"]) ?? "") || tagAttrs(b, "link", "href")[0]?.value || "";
    const entryTitle = stripTags(firstTag(b, ["title"]) ?? "");
    const date = isoOrNull(firstTag(b, atom ? ["published", "updated"] : ["pubDate", "dc:date", "published", "updated"]));
    const summary = stripTags(firstTag(b, atom ? ["summary", "content"] : ["description", "content:encoded", "summary"]) ?? "").slice(0, SUMMARY_CHARS);
    const author = stripTags(firstTag(b, atom ? ["name"] : ["dc:creator", "author"]) ?? "") || undefined;
    const idRaw = atom ? firstTag(b, ["id"]) : firstTag(b, ["guid"]) ?? /\brdf:about\s*=\s*"([^"]*)"/.exec(m[0]!)?.[1];
    const id = (idRaw ? text(idRaw) : "") || url || `${entryTitle}|${date ?? ""}`;
    if (!id && !url) continue;
    entries.push({ id, title: entryTitle, url, date, summary, ...(author ? { author } : {}) });
  }
  return { title, link: link || undefined, kind: atom ? "atom" : "rss", entries };
}

const BOILERPLATE = /^(comments?|read more|continue reading(?: →|\.\.\.|…)?|more|link|permalink|\[?(link|comments)\]?|article url:.*)$/i;
/** True when the feed summary carries no content worth judging by (empty, a few words, or a stock phrase). */
export function isThinSummary(summary: string): boolean {
  const t = summary.replace(/\s+/g, " ").trim();
  return t.length < THIN_SUMMARY_CHARS || BOILERPLATE.test(t);
}

/** Head of the readable text of an article page (Readability → Markdown → plain text), at most SUMMARY_CHARS. */
export async function pageSummary(html: string, url: string): Promise<string> {
  const { htmlToMarkdown } = await import("../../html");
  const { markdown } = htmlToMarkdown(html, url);
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^#{1,6}\s+/gm, "").replace(/^[-*>]\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ").trim();
  return text.slice(0, SUMMARY_CHARS);
}

/**
 * Replace thin summaries with the head of each entry's page. Best effort: a page that cannot be fetched or read keeps
 * the feed's summary; a host that failed once is not tried again in this run; the whole run fetches at most `budget`
 * pages (first come, first served across feeds). Returns how many pages were fetched.
 */
export async function fillThinSummaries(entries: RssEntry[], http: HttpClient, log: Logger, state: { budget: number; failedHosts: Set<string> }): Promise<number> {
  const todo = entries.filter((e) => e.url && isThinSummary(e.summary)).slice(0, Math.max(0, state.budget));
  state.budget -= todo.length;
  // one worker per host (hosts in parallel): a host that fails is dropped before its next entry is tried
  const byHost = new Map<string, RssEntry[]>();
  for (const e of todo) {
    let host = "";
    try { host = new URL(e.url).hostname; } catch { continue; }
    byHost.get(host)?.push(e) ?? byHost.set(host, [e]);
  }
  let fetched = 0;
  await mapLimit([...byHost.entries()], PAGE_FETCH_CONCURRENCY, async ([host, list]) => {
    for (const e of list) {
      if (state.failedHosts.has(host)) return;
      try {
        // best effort: no retries and a short timeout, or one slow / rate-limiting site holds the whole run
        const res = await http.fetch(e.url, { headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "user-agent": "my-knowledge-collector" }, retry: { retries: 0, timeoutMs: 15_000 } });
        const type = res.headers.get("content-type") ?? "";
        if (type && !/html|xml/i.test(type)) continue; // a PDF, an image: nothing to read here
        const html = (await res.text()).slice(0, PAGE_BYTES_MAX);
        const head = await pageSummary(html, e.url);
        if (head.length >= THIN_SUMMARY_CHARS) { e.summary = head; e.summary_source = "page"; fetched++; }
      } catch (err) {
        state.failedHosts.add(host);
        log.info(`  rss page ${host}: ${String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 100)}`);
        return;
      }
    }
  });
  return fetched;
}

/** File-name slug from the feed URL: host (no www.) + path, minus the usual feed suffixes. */
export function feedSlug(url: string): string {
  let host = "", path = "";
  try { const u = new URL(url); host = u.hostname.replace(/^www\./, ""); path = u.pathname; } catch { host = url; }
  path = path.replace(/\/(index|feed|rss|atom|default)?(\.(xml|rss|atom|rdf|json))?\/?$/i, "").replace(/\/(feed|rss|atom)\/?$/i, "");
  const slug = `${host}${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40).replace(/-+$/, "") || "feed";
}

/** FEED_URLS → targets with unique slugs (a clash gets -2, -3, …). */
export function feedTargets(env: Record<string, string | undefined>): FeedTarget[] {
  const urls = [...new Set((env.FEED_URLS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
  const used = new Map<string, number>();
  return urls.map((url) => {
    const base = feedSlug(url);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { url, slug: n === 1 ? base : `${base}-${n}` };
  });
}

function loadCursor(raw: string | undefined): Cursor {
  try { const c = raw ? (JSON.parse(raw) as Cursor) : undefined; if (c?.v === 1 && c.feeds) return c; } catch { /* reset */ }
  return { v: 1, feeds: {} };
}

/** New entries of one feed given the ids seen before (undefined = first run → the window, or the newest few). */
export function newEntries(parsed: ParsedFeed, seen: string[] | undefined, from: Date): RssEntry[] {
  if (seen) { const s = new Set(seen); return parsed.entries.filter((e) => !s.has(e.id)); }
  const dated = parsed.entries.filter((e) => e.date && Date.parse(e.date) >= from.getTime());
  return dated.length || parsed.entries.some((e) => e.date) ? dated : parsed.entries.slice(0, FIRST_RUN_MAX);
}

export const rss: Collector = {
  id: "rss",
  label: "RSS / Atom",
  lookbackDays: 7,
  configured: (env) => (feedTargets(env).length ? true : "missing FEED_URLS"),
  async collect({ env, http, from, to, cursor, log }) {
    const prev = loadCursor(cursor);
    const next: Cursor = { v: 1, feeds: {} };
    const files: InboxFile[] = [];
    const failures: string[] = [];
    let count = 0, succeeded = 0, pages = 0;
    const pageState = { budget: PAGE_FETCH_MAX, failedHosts: new Set<string>() };
    const f = ymd(from), t = ymd(to);
    for (const { url, slug } of feedTargets(env)) {
      try {
        const res = await http.fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8", "user-agent": "my-knowledge-collector" } });
        const parsed = parseFeed(await res.text());
        succeeded++;
        const fresh = newEntries(parsed, prev.feeds[url], from).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
        next.feeds[url] = [...new Set([...parsed.entries.map((e) => e.id), ...(prev.feeds[url] ?? [])])].slice(0, SEEN_MAX);
        if (!fresh.length) continue;
        count += fresh.length;
        pages += await fillThinSummaries(fresh, http, log, pageState);
        const feed: Feed<RssEntry> = { source: "rss", from: f, to: t, collected_at: new Date().toISOString(), count: fresh.length, meta: { feed: url, title: parsed.title, slug, kind: parsed.kind }, items: fresh };
        files.push({ name: `collect-rss-${slug}-${f}_${t}.json`, json: feed });
      } catch (e) {
        // one broken feed must not hold the others back: keep its old ids and retry it next run
        const msg = String((e as Error)?.message ?? e).slice(0, 160);
        failures.push(`${slug}: ${msg}`);
        log.warn(`  rss ${slug}: ${msg}`);
        if (prev.feeds[url]) next.feeds[url] = prev.feeds[url]!;
      }
    }
    if (failures.length && !succeeded) throw new Error(`every feed failed — ${failures.join("; ")}`);
    if (pages) log.info(`  rss: ${pages} page head(s) fetched for entries with a thin feed summary`);
    return { files, count, cursor: JSON.stringify(next) };
  },
  digest(item) {
    const it = item as RssEntry;
    const head = it.summary.length > 120 ? `${it.summary.slice(0, 120)}…` : it.summary;
    return `${it.date ? it.date.slice(0, 10) : "----------"} ${it.title || "(no title)"} ${it.url}${head ? ` — ${head}` : ""}`;
  },
};
