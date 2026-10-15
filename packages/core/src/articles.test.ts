import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { readMeta, walkBronze } from "./bronze";
import {
  ARTICLES_DIR, CURATE_OUTPUT_REL, applyCurateOutput, articleId, articleStats, buildCurateInput, buildHistory, collectCandidates, curateArticles,
  knownArticleIds, listArticleDays, loadArticlePrefs, parseCurateOutput, reactToArticle, renderArticlesGold, writeArticleDay, type ArticleDay, type ArticleItem,
} from "./articles";

/** A throwaway data repo (fixture only: made-up feeds). */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kb-articles-"));
  for (const d of ["000_inbox", "100_bronze", "200_silver", "300_gold", "800_templates", "900_system/schemas"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# test\n");
  return root;
}
function feedFile(root: string, slug: string, items: { title: string; url: string; date?: string; summary?: string }[]) {
  const name = `collect-rss-${slug}-2026-10-14_2026-10-15.json`;
  writeFileSync(join(root, "000_inbox", name), JSON.stringify({ source: "rss", from: "2026-10-14", to: "2026-10-15", collected_at: "2026-10-15T06:30:00Z", count: items.length, meta: { feed: `https://${slug}.example/feed`, title: slug, slug, kind: "rss" }, items: items.map((i, n) => ({ id: `${slug}-${n}`, title: i.title, url: i.url, date: i.date ?? "2026-10-14T10:00:00Z", summary: i.summary ?? "" })) }));
  return name;
}
const item = (o: Partial<ArticleItem> & { title: string; url: string }): ArticleItem => ({ id: articleId(o.url), feed: "f", published: "2026-10-01", summary: "", bronze: "b", picked: false, ...o });

describe("collectCandidates", () => {
  test("moves inbox rss files to Bronze and expands their entries, deduped by url", () => {
    const root = fixtureRoot(); const cfg = loadConfig(root);
    feedFile(root, "alpha", [{ title: "A1", url: "https://a.example/1", summary: "x".repeat(300) }, { title: "A2", url: "https://a.example/2" }, { title: "A1 again", url: "https://a.example/1" }]);
    feedFile(root, "beta", [{ title: "B1", url: "https://b.example/1", date: "2026-10-15T01:00:00Z" }, { title: "known", url: "https://b.example/known" }]);
    const { items, bronzeIds } = collectCandidates(cfg, new Set([articleId("https://b.example/known")]));
    expect(bronzeIds.length).toBe(2);
    expect(items.map((i) => i.title)).toEqual(["B1", "A1", "A2"]); // newest first
    expect(items[1]!.feed).toBe("alpha");
    expect(existsSync(join(root, "000_inbox"))).toBe(true);
    expect([...walkBronze(cfg)].every((m) => m.kind === "feed" && m.processed_to.length === 0)).toBe(true);
    // a second call sees the same (still unprocessed) feeds, nothing is moved twice
    expect(collectCandidates(cfg, new Set()).items.length).toBe(4);
  });
});

describe("buildHistory", () => {
  const days: ArticleDay[] = [
    { date: "2026-10-14", curated_at: "", feeds: ["f", "g"], items: [
      item({ title: "p1", url: "u1", picked: true, basis: "fit", opened_at: "t" }),
      item({ title: "p2", url: "u2", picked: true, basis: "general", reaction: "dismissed" }),
      item({ title: "p3", url: "u3", picked: true, basis: "fit" }),
      item({ title: "m1", url: "u4", feed: "g", opened_at: "t" }),
      item({ title: "s1", url: "u5", feed: "g", picked: true, basis: "general", opened_at: "t", reaction: "saved" }),
    ] },
    { date: "2026-10-15", curated_at: "", feeds: ["f"], items: [item({ title: "fresh", url: "u6", picked: true, basis: "fit" })] },
  ];
  test("counts per feed and per basis, lists titles, flags missed and ignored", () => {
    const h = buildHistory(days, { now: new Date("2026-10-16T09:00:00+09:00") });
    expect(h.feeds.f).toEqual({ candidates: 4, picked: 4, opened: 1, saved: 0, dismissed: 1, missed: 0 });
    expect(h.feeds.g).toEqual({ candidates: 2, picked: 1, opened: 2, saved: 1, dismissed: 0, missed: 1 });
    expect(h.basis.general).toEqual({ picked: 2, opened: 1, saved: 1, dismissed: 1 });
    expect(h.opened).toEqual(["p1 (f)", "m1 (g)", "s1 (g)"]);
    expect(h.missed).toEqual(["m1 (g)"]);
    expect(h.saved).toEqual(["s1 (g)"]);
    expect(h.dismissed).toEqual(["p2 (f)"]);
    // p3 (2 days old, untouched) is ignored; "fresh" (yesterday) is not judged yet
    expect(h.ignored).toEqual(["p3 (f)"]);
  });
  test("missed counts an opened unpicked entry against its feed", () => {
    const h = buildHistory([{ date: "2026-10-14", curated_at: "", feeds: ["g"], items: [item({ title: "m", url: "x", feed: "g", opened_at: "t" })] }], { now: new Date("2026-10-15T00:00:00Z") });
    expect(h.feeds.g!.missed).toBe(1);
    expect(h.basis.fit.picked).toBe(0);
  });
});

describe("parseCurateOutput", () => {
  const input = { max: 3, explore_min: 1, items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }].map((i) => ({ ...i, title: i.id, feed: "f", published: null, summary: "" })) };
  test("accepts picks by id, clips the reason, defaults basis to fit with a warning", () => {
    const r = parseCurateOutput({ picks: [{ id: "a", basis: "general", reason: " r ".repeat(60), topics: ["x", "", "y"] }, { id: "b", reason: "ok" }] }, input);
    expect(r.picks.map((p) => [p.id, p.basis])).toEqual([["a", "general"], ["b", "fit"]]);
    expect(r.picks[0]!.reason.length).toBeLessThanOrEqual(81);
    expect(r.picks[0]!.topics).toEqual(["x", "y"]);
    expect(r.warnings).toEqual(['pick b: basis undefined read as fit']);
  });
  test("rejects unknown ids and malformed output", () => {
    expect(() => parseCurateOutput({ picks: [{ id: "zzz", basis: "fit", reason: "r" }] }, input)).toThrow(/unknown id/);
    expect(() => parseCurateOutput({ result: [] }, input)).toThrow(/expected/);
    expect(() => parseCurateOutput("[]", input)).toThrow(/expected/);
  });
  test("warns on a short general quota and trims over the cap keeping general picks first", () => {
    const r = parseCurateOutput({ picks: [{ id: "a", basis: "fit", reason: "1" }, { id: "b", basis: "fit", reason: "2" }, { id: "c", basis: "fit", reason: "3" }, { id: "d", basis: "general", reason: "4" }, { id: "a", basis: "fit", reason: "dup" }] }, input);
    expect(r.picks.map((p) => p.id)).toEqual(["a", "b", "d"]);
    expect(r.warnings.some((w) => w.includes("cap 3"))).toBe(true);
    const short = parseCurateOutput({ picks: [{ id: "a", basis: "fit", reason: "1" }, { id: "b", basis: "fit", reason: "2" }] }, input);
    expect(short.warnings).toEqual(["only 0 general pick(s), 1 wanted"]);
  });
});

describe("curateArticles end to end", () => {
  test("input has no urls and clipped summaries; output becomes the day file, Bronze is marked, a rerun merges", async () => {
    const root = fixtureRoot(); const cfg = loadConfig(root);
    writeFileSync(join(root, "900_system/article-prefs.json"), JSON.stringify({ max_per_day: 2, explore_min: 1, interests: ["Kubernetes"], avoid: ["press releases"] }));
    feedFile(root, "alpha", [{ title: "A1", url: "https://a.example/1", summary: "s".repeat(300) }, { title: "A2", url: "https://a.example/2" }, { title: "A3", url: "https://a.example/3" }]);
    let seenInput: Record<string, unknown> | null = null;
    const run = async (inPath: string, outPath: string) => {
      seenInput = JSON.parse(readFileSync(inPath, "utf8"));
      const ids = (seenInput!.items as { id: string }[]).map((i) => i.id);
      writeFileSync(outPath, JSON.stringify({ picks: [{ id: ids[0], basis: "general", reason: "big news", topics: ["k8s"] }, { id: ids[2], basis: "fit", reason: "fits" }] }));
    };
    const now = new Date("2026-10-15T07:10:00+09:00"), date = "2026-10-15"; // bun test runs in UTC: the date is given explicitly
    const dry = await curateArticles(cfg, { now, date, dry: true, run });
    expect(dry.input!.items.length).toBe(3);
    expect(JSON.stringify(dry.input)).not.toContain("https://");
    expect(dry.input!.items[0]!.summary.length).toBe(201);
    expect(dry.input!.interests).toEqual(["Kubernetes"]);
    expect(dry.input!.max).toBe(2);

    const r = await curateArticles(cfg, { now, date, run });
    expect(seenInput).not.toBeNull();
    expect(r.path).toBe(`${ARTICLES_DIR}/2026-10-15.json`);
    expect(r.warnings).toEqual([]);
    const day = r.day!;
    expect(day.items.length).toBe(3);
    expect(day.items.filter((i) => i.picked).map((i) => [i.title, i.basis, i.reason])).toEqual([["A1", "general", "big news"], ["A3", "fit", "fits"]]);
    expect(day.items[0]!.url).toBe("https://a.example/1");
    const meta = [...walkBronze(cfg)][0]!;
    expect(meta.processed_to).toEqual([r.path!]);
    expect(articleStats(day)).toEqual({ candidates: 3, picked: 2, opened: 0, saved: 0, dismissed: 0 });
    expect(existsSync(join(root, CURATE_OUTPUT_REL))).toBe(true);

    // the same day again with one more feed: already-seen urls are not offered, earlier items (and reactions) survive
    reactToArticle(cfg, { date: "2026-10-15", id: articleId("https://a.example/3"), reaction: "saved", now });
    feedFile(root, "beta", [{ title: "B1", url: "https://b.example/1" }, { title: "A1 copy", url: "https://a.example/1" }]);
    const r2 = await curateArticles(cfg, { now, date, run: async (inPath, outPath) => {
      const inp = JSON.parse(readFileSync(inPath, "utf8")) as { items: { id: string; title: string }[]; history: { saved: string[] } };
      expect(inp.items.map((i) => i.title)).toEqual(["B1"]);
      expect(inp.history.saved).toEqual(["A3 (alpha)"]);
      writeFileSync(outPath, JSON.stringify({ picks: [{ id: inp.items[0]!.id, basis: "general", reason: "new" }] }));
    } });
    expect(r2.day!.items.map((i) => i.title)).toEqual(["A1", "A2", "A3", "B1"]);
    expect(r2.day!.items[2]!.reaction).toBe("saved");
    expect(r2.day!.feeds).toEqual(["alpha", "beta"]);
    expect(knownArticleIds(cfg, 30, now).size).toBe(4);
    // nothing new → skipped, and the empty feed is marked `-`
    feedFile(root, "gamma", [{ title: "A1 again", url: "https://a.example/1" }]);
    const r3 = await curateArticles(cfg, { now, date, run: async () => { throw new Error("must not run"); } });
    expect(r3.skipped).toBe(true);
    expect([...walkBronze(cfg)].map((m) => m.processed_to.join(",")).sort()).toEqual(["-", `${ARTICLES_DIR}/2026-10-15.json`, `${ARTICLES_DIR}/2026-10-15.json`]);
  });
  test("an agent that writes nothing or bad JSON fails the run and leaves Bronze unprocessed", async () => {
    const root = fixtureRoot(); const cfg = loadConfig(root);
    feedFile(root, "alpha", [{ title: "A1", url: "https://a.example/1" }]);
    await expect(curateArticles(cfg, { run: async () => {} })).rejects.toThrow(/did not write/);
    await expect(curateArticles(cfg, { run: async (_i, o) => writeFileSync(o, "not json") })).rejects.toThrow(/not JSON/);
    expect([...walkBronze(cfg)][0]!.processed_to).toEqual([]);
    expect(listArticleDays(cfg).length).toBe(0);
  });
});

describe("reactToArticle / listing / Gold", () => {
  test("opened keeps a later save; dismissed replaces; paging by date; Gold marks", () => {
    const root = fixtureRoot(); const cfg = loadConfig(root);
    const mk = (date: string, titles: string[]) => writeArticleDay(cfg, { date, curated_at: "", feeds: ["f"], items: titles.map((t, i) => item({ title: t, url: `https://x/${date}/${i}`, picked: i === 0, basis: "fit", reason: "why" })) });
    for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) mk(d, ["first", "second"]);
    const id = articleId("https://x/2026-10-14/0");
    const t1 = new Date("2026-10-14T10:00:00Z");
    const a = reactToArticle(cfg, { date: "2026-10-14", id, reaction: "opened", now: t1 });
    expect(a.item.opened_at).toBe(t1.toISOString());
    const b = reactToArticle(cfg, { date: "2026-10-14", id, reaction: "saved", now: new Date("2026-10-14T10:01:00Z") });
    expect(b.item).toMatchObject({ opened_at: t1.toISOString(), reaction: "saved" });
    reactToArticle(cfg, { date: "2026-10-14", id, reaction: "opened", now: new Date("2026-10-14T11:00:00Z") });
    const saved = JSON.parse(readFileSync(join(root, b.path), "utf8")) as ArticleDay;
    expect(saved.items[0]!.opened_at).toBe(t1.toISOString()); // first open wins
    expect(() => reactToArticle(cfg, { date: "2026-10-14", id: "nope", reaction: "opened" })).toThrow(/not found/);
    expect(() => reactToArticle(cfg, { date: "14", id, reaction: "opened" })).toThrow(/bad date/);

    expect(listArticleDays(cfg, { limit: 1 }).map((d) => d.date)).toEqual(["2026-10-14"]);
    expect(listArticleDays(cfg, { limit: 5, before: "2026-10-14" }).map((d) => d.date)).toEqual(["2026-10-13", "2026-10-12"]);
    const gold = renderArticlesGold(cfg);
    expect(gold).toContain("## 2026-10-14（1 件 / 候補 2 件）");
    expect(gold).toContain("- ◎ [first](https://x/2026-10-14/0) — f — why");
    expect(gold).not.toContain("second");
    expect(loadArticlePrefs(cfg)).toEqual({ max_per_day: 8, explore_min: 2, interests: [], avoid: [] });
    expect(readMeta(cfg, "nope")).toBeNull();
  });
  test("buildCurateInput merges prefs interests with the notes'", () => {
    const root = fixtureRoot(); const cfg = loadConfig(root);
    const input = buildCurateInput(cfg, [item({ title: "t", url: "u", summary: "s" })], { date: "2026-10-15", prefs: { max_per_day: 5, explore_min: 2, interests: ["Rust"], avoid: [] } });
    expect(input).toMatchObject({ date: "2026-10-15", max: 5, explore_min: 2, interests: ["Rust"], items: [{ title: "t", feed: "f", summary: "s" }] });
    expect(input.history.days).toBe(90);
  });
});
