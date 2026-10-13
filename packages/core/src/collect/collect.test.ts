import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, createHttp, HttpError, mapLimit, retryDecision } from "./http";
import { csvObjects, parseCsv } from "./csv";
import { digestJson } from "./digest";
import { bodyText, mailFileName, toMailItem } from "./sources/gmail";
import { healthMetrics, type HealthDay } from "./sources/health";
import { feedName, loadState, runCollectors } from "./run";
import type { Collector } from "./types";
import type { KbConfig } from "../config";

const res = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? "{}" : "err", { status, headers });

describe("retryDecision", () => {
  test("429 and 5xx retry; other 4xx do not", () => {
    expect(retryDecision(res(429)).retry).toBe(true);
    expect(retryDecision(res(503)).retry).toBe(true);
    expect(retryDecision(res(404)).retry).toBe(false);
    expect(retryDecision(res(401)).retry).toBe(false);
  });
  test("Retry-After seconds and HTTP dates", () => {
    expect(retryDecision(res(429, { "retry-after": "7" })).waitMs).toBe(7000);
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(retryDecision(res(503, { "retry-after": "Mon, 12 Oct 2026 00:00:30 GMT" }), now).waitMs).toBe(30_000);
  });
  test("GitHub primary rate limit: 403 with remaining 0 waits until reset", () => {
    const now = 1_000_000_000_000;
    const d = retryDecision(res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 60) }), now);
    expect(d.retry).toBe(true);
    expect(d.waitMs).toBe(61_000);
    expect(retryDecision(res(403)).retry).toBe(false); // plain permission error
  });
  test("Google quota 403 retries (a per-minute quota waits out the minute); disallowed scopes do not", () => {
    const quota = JSON.stringify({ error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } });
    expect(retryDecision(res(403), Date.now(), quota)).toEqual({ retry: true, waitMs: 61_000 });
    expect(retryDecision(res(403), Date.now(), '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}').retry).toBe(true);
    expect(retryDecision(res(403), Date.now(), '{"error":{"details":[{"reason":"DISALLOWED_OAUTH_SCOPES"}]}}').retry).toBe(false);
  });
  test("createHttp passes the 403 body to the decision", async () => {
    const bodies = ['{"error":{"details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}', "{}"];
    const waits: number[] = [];
    const http = createHttp({ fetchImpl: (async () => { const b = bodies.shift()!; return new Response(b, { status: b === "{}" ? 200 : 403 }); }) as unknown as typeof fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(await http.json<Record<string, never>>("https://example.test/x")).toEqual({});
    expect(waits.length).toBe(1);
  });
});

describe("backoff", () => {
  test("full jitter grows exponentially and is capped", () => {
    const p = { retries: 5, baseMs: 1000, maxMs: 60_000, timeoutMs: 1000 };
    expect(backoffMs(0, p, () => 0.999)).toBe(999);
    expect(backoffMs(3, p, () => 0.999)).toBe(7992);
    expect(backoffMs(10, p, () => 0.999)).toBe(59_940);
  });
  test("createHttp retries then succeeds, sleeping between attempts", async () => {
    const statuses = [503, 429, 200];
    const waits: number[] = [];
    const http = createHttp({ fetchImpl: (async () => res(statuses.shift()!, { "retry-after": "2" })) as unknown as typeof fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(await http.json<Record<string, never>>("https://example.test/x")).toEqual({});
    expect(waits).toEqual([2000, 2000]);
  });
  test("gives up after the retry budget and redacts the query string", async () => {
    const http = createHttp({ policy: { retries: 2 }, fetchImpl: (async () => res(500)) as unknown as typeof fetch, sleep: async () => {} });
    const err = await http.json("https://example.test/x?key=secret").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toContain("secret");
  });
  test("an empty 2xx body is undefined, not a JSON error", async () => {
    const http = createHttp({ fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    expect(await http.json("https://example.test/batchModify")).toBeUndefined();
  });
  test("non-retryable errors fail immediately", async () => {
    let calls = 0;
    const http = createHttp({ fetchImpl: (async () => { calls++; return res(401); }) as unknown as typeof fetch, sleep: async () => {} });
    await expect(http.json("https://example.test/x")).rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
  });
  test("mapLimit keeps order and bounds concurrency", async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => { inFlight++; peak = Math.max(peak, inFlight); await Bun.sleep(5); inFlight--; return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

describe("csv", () => {
  test("quoted commas, doubled quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nline2"\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"\nline2']]);
  });
  test("header after a preamble (LinkedIn Connections.csv)", () => {
    const t = "Notes:\n\"When exporting…\"\n\nFirst Name,Last Name,URL\nTaro,Yamada,https://linkedin.example/taro\n";
    expect(csvObjects(t, "First Name")).toEqual([{ "First Name": "Taro", "Last Name": "Yamada", URL: "https://linkedin.example/taro" }]);
  });
});

const b64url = (s: string) => Buffer.from(s).toString("base64url");

describe("gmail", () => {
  const msg = {
    id: "18f0a1b2c3d4e5f6", threadId: "t1", labelIds: ["L1"], snippet: "snip", internalDate: String(Date.parse("2026-10-11T03:00:00Z")),
    payload: {
      mimeType: "multipart/mixed", headers: [{ name: "From", value: "shop@example.test" }, { name: "Subject", value: "ご注文確認" }, { name: "X-Junk", value: "x" }],
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64url("<p>合計 <b>1,200</b> 円</p>") } }] },
        { mimeType: "application/pdf", filename: "receipt.pdf", body: { attachmentId: "a1" } },
      ],
    },
  };
  test("falls back to stripped HTML and lists attachments", () => {
    expect(bodyText(msg.payload)).toBe("合計 1,200 円");
    const it = toMailItem(msg, "KB/購入");
    expect(it.category).toBe("purchase");
    expect(it.attachments).toEqual(["receipt.pdf"]);
    expect(it.headers.map((h) => h.name)).toEqual(["From", "Subject"]);
    expect(mailFileName(it)).toMatch(/^mail-2026101[12]-purchase-18f0a1b2c3d4e5f6\.json$/);
  });
  test("digest renders the header block and body for kb source", () => {
    const d = digestJson(JSON.stringify(toMailItem(msg, "KB/購入")))!;
    expect(d).toContain("subject: ご注文確認");
    expect(d).toContain("---\n合計 1,200 円");
  });
});

const day: HealthDay = {
  date: "2026-10-10",
  rollups: {
    steps: { civilStartTime: { date: { year: 2026, month: 10, day: 10 } }, civilEndTime: { date: { year: 2026, month: 10, day: 11 } }, steps: { countSum: "8123" } },
    distance: { civilStartTime: { date: { year: 2026, month: 10, day: 10 } }, civilEndTime: { date: { year: 2026, month: 10, day: 11 } }, distance: { millimetersSum: "6123456" } },
    "total-calories": { civilStartTime: { date: { year: 2026, month: 10, day: 10 } }, civilEndTime: { date: { year: 2026, month: 10, day: 11 } }, totalCalories: { kcalSum: 2210.6 } },
    "active-minutes": { civilStartTime: { date: { year: 2026, month: 10, day: 10 } }, civilEndTime: { date: { year: 2026, month: 10, day: 11 } }, activeMinutes: { activeMinutesRollupByActivityLevel: [{ activityLevel: "LIGHT", activeMinutesSum: "30" }, { activityLevel: "VIGOROUS", activeMinutesSum: "12" }] } },
  },
  sleep: [{ sleep: { interval: { startTime: "2026-10-09T14:30:00Z", endTime: "2026-10-09T21:40:00Z" }, type: "STAGES", summary: { minutesAsleep: "402", stagesSummary: [{ type: "DEEP", minutes: "70" }, { type: "REM", minutes: "88" }] } } }],
};

describe("health", () => {
  test("flattens rollups and sleep into daily numbers", () => {
    expect(healthMetrics(day)).toEqual({ date: "2026-10-10", steps: 8123, distanceKm: 6.12, kcal: 2211, activeMinutes: 42, sleepMinutes: 402, deepMinutes: 70, remMinutes: 88 });
  });
  test("missing data stays null, not 0", () => {
    expect(healthMetrics({ date: "2026-10-11", rollups: {}, sleep: [] })).toEqual({ date: "2026-10-11", steps: null, distanceKm: null, kcal: null, activeMinutes: null, sleepMinutes: null, deepMinutes: null, remMinutes: null });
  });
});

describe("runCollectors", () => {
  const mkCfg = () => {
    const root = mkdtempSync(join(tmpdir(), "kb-collect-"));
    return { root, inbox: join(root, "000_inbox"), cache: join(root, "900_system", "cache") } as unknown as KbConfig;
  };
  const fake = (id: string, impl: Collector["collect"], configured: true | string = true): Collector => ({ id, label: id, lookbackDays: 7, configured: () => configured, collect: impl, digest: (x) => JSON.stringify(x) });
  const now = new Date(2026, 9, 12, 6, 30);

  test("runs in parallel, isolates failures, skips unconfigured, writes feeds and state", async () => {
    const cfg = mkCfg();
    let commits = 0;
    const reports = await runCollectors(cfg, {}, {
      now, log: { info() {}, warn() {} },
      collectors: [
        fake("ok", async () => ({ items: [{ a: 1 }, { a: 2 }], cursor: "c1", commit: async () => { commits++; } })),
        fake("boom", async () => { throw new Error("HTTP 401"); }),
        fake("off", async () => ({}), "missing TOKEN"),
        fake("empty", async () => ({ items: [] })),
      ],
    });
    expect(reports.map((r) => [r.id, r.status])).toEqual([["ok", "ok"], ["boom", "failed"], ["off", "skipped"], ["empty", "ok"]]);
    const name = feedName("ok", "2026-10-05", "2026-10-12");
    expect(readdirSync(cfg.inbox)).toEqual([name]); // empty feed → no file
    const feed = JSON.parse(readFileSync(join(cfg.inbox, name), "utf8"));
    expect(feed).toMatchObject({ source: "ok", from: "2026-10-05", to: "2026-10-12", count: 2 });
    expect(commits).toBe(1);
    const st = loadState(cfg);
    expect(st.ok?.cursor).toBe("c1");
    expect(st.boom?.lastError).toBe("HTTP 401");
    expect(st.boom?.lastTo).toBeUndefined(); // failed window is retried next time
  });

  test("second run starts from the saved window end; an existing inbox file is not overwritten", async () => {
    const cfg = mkCfg();
    const seen: Date[] = [];
    const c = fake("src", async ({ from }) => { seen.push(from); return { files: [{ name: "mail-x.json", json: { v: seen.length } }] }; });
    await runCollectors(cfg, {}, { now, collectors: [c], log: { info() {}, warn() {} } });
    const later = new Date(2026, 9, 13, 6, 30);
    const r = await runCollectors(cfg, {}, { now: later, collectors: [c], log: { info() {}, warn() {} } });
    expect(seen[1]!.getTime()).toBe(now.getTime());
    expect(r[0]!.skippedExisting).toEqual(["mail-x.json"]);
    expect(JSON.parse(readFileSync(join(cfg.inbox, "mail-x.json"), "utf8"))).toEqual({ v: 1 });
  });

  test("dry run writes nothing and keeps state", async () => {
    const cfg = mkCfg();
    let commits = 0;
    const r = await runCollectors(cfg, {}, { now, dryRun: true, log: { info() {}, warn() {} }, collectors: [fake("d", async () => ({ items: [1], commit: async () => { commits++; } }))] });
    expect(r[0]!.written).toEqual([feedName("d", "2026-10-05", "2026-10-12")]);
    expect(existsSync(cfg.inbox)).toBe(false);
    expect(commits).toBe(0);
    expect(loadState(cfg)).toEqual({});
  });

  test("unknown source names are rejected", async () => {
    await expect(runCollectors(mkCfg(), {}, { only: ["nope"], collectors: [] })).rejects.toThrow("unknown source");
  });
});

describe("feed digest", () => {
  test("unknown sources fall back to JSON lines", () => {
    const d = digestJson(JSON.stringify({ source: "x", from: "2026-10-01", to: "2026-10-08", count: 1, items: [{ k: "v" }] }))!;
    expect(d).toContain("# x 2026-10-01 〜 2026-10-08（1 件）");
    expect(d).toContain('- {"k":"v"}');
  });
  test("non-feed JSON is left alone", () => {
    expect(digestJson('{"hello":1}')).toBeNull();
    expect(digestJson("not json")).toBeNull();
  });
});


describe("linkedin export", () => {
  const { linkedin } = require("./sources/linkedin") as typeof import("./sources/linkedin");
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");

  async function makeZip(dir: string, name: string, files: Record<string, string>) {
    const src = mkdtempSync(join(tmpdir(), "kb-li-src-"));
    mkdirSync(src, { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(join(src, f), t);
    const p = Bun.spawn(["zip", "-q", "-r", join(dir, name), "."], { cwd: src });
    expect(await p.exited).toBe(0);
  }
  const conn = (rows: string) => `Notes:\n"When exporting your connection data, you may notice…"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n${rows}`;
  const profile = "First Name,Last Name,Maiden Name,Address,Birth Date,Headline\nTaro,Yamada,,Tokyo 1-2-3,Jan 1,Engineer\n";
  const messages = (rows: string) => `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER\n${rows}`;

  test("first export: profile without sensitive fields, all connections and messages; second: only what is new", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-li-"));
    const cfg = { root, inbox: join(root, "000_inbox"), cache: join(root, "c") } as unknown as KbConfig;
    mkdirSync(cfg.inbox);
    await makeZip(cfg.inbox, "Basic_LinkedInDataExport_10-01-2026.zip", {
      "Profile.csv": profile,
      "Positions.csv": "Company Name,Title,Description,Location,Started On,Finished On\nExample Inc,SWE,,Tokyo,Apr 2020,\n",
      "Connections.csv": conn("Hanako,Sato,https://li.example/hanako,,Acme,Recruiter,01 Oct 2026\n"),
      "messages.csv": messages('c1,転職のご相談,Hanako Sato,u,Taro Yamada,u,2026-10-01 09:00:00 UTC,,"はじめまして。\nポジションのご案内です",INBOX\n'),
    });
    const log = { info() {}, warn() {} };
    const r1 = await runCollectors(cfg, {}, { collectors: [linkedin], log });
    expect(r1[0]).toMatchObject({ status: "ok", items: 4 });
    const feed1 = JSON.parse(readFileSync(join(cfg.inbox, r1[0]!.written[0]!), "utf8"));
    const prof = feed1.items.find((i: { section: string }) => i.section === "profile").row;
    expect(prof).toEqual({ "First Name": "Taro", "Last Name": "Yamada", Headline: "Engineer" });
    expect(feed1.items.find((i: { section: string }) => i.section === "message").row.CONTENT).toBe("はじめまして。\nポジションのご案内です");

    // same ZIP again: nothing new
    const again = await runCollectors(cfg, {}, { collectors: [linkedin], log });
    expect(again[0]!.written).toEqual([]);

    // newer export with one more connection and one more message
    await Bun.sleep(1100); // distinct mtime
    await makeZip(cfg.inbox, "Basic_LinkedInDataExport_11-01-2026.zip", {
      "Profile.csv": profile,
      "Connections.csv": conn("Hanako,Sato,https://li.example/hanako,,Acme,Recruiter,01 Oct 2026\nJiro,Ito,https://li.example/jiro,,Beta,CTO,20 Oct 2026\n"),
      "messages.csv": messages('c1,転職のご相談,Hanako Sato,u,Taro Yamada,u,2026-10-01 09:00:00 UTC,,"はじめまして。",INBOX\nc1,転職のご相談,Taro Yamada,u,Hanako Sato,u,2026-10-21 10:00:00 UTC,,ぜひ,INBOX\n'),
    });
    const r2 = await runCollectors(cfg, {}, { collectors: [linkedin], log });
    const feed2 = JSON.parse(readFileSync(join(cfg.inbox, r2[0]!.written[0]!), "utf8"));
    expect(feed2.items.filter((i: { section: string }) => i.section === "connection").map((i: { row: Record<string, string> }) => i.row["First Name"])).toEqual(["Jiro"]);
    expect(feed2.items.filter((i: { section: string }) => i.section === "message").map((i: { row: Record<string, string> }) => i.row.CONTENT)).toEqual(["ぜひ"]);
  });
});

describe("sources against a fake API", () => {
  type Call = { url: string; init?: RequestInit };
  const fakeHttp = (route: (c: Call) => unknown) => {
    const calls: Call[] = [];
    const http = {
      async fetch(url: string, init?: RequestInit) { calls.push({ url, init }); return new Response(JSON.stringify(route({ url, init }))); },
      async json<T>(url: string, init?: RequestInit) { calls.push({ url, init }); return route({ url, init }) as T; },
    };
    return { http, calls };
  };
  const google = { configured: true as const, accessToken: async () => "tok" };
  const ctxBase = { cfg: {} as KbConfig, cursor: undefined, log: { info() {}, warn() {} }, dryRun: false, google };

  test("github: search queries cover the window; PRs, issues and commits are told apart", async () => {
    const { github } = require("./sources/github") as typeof import("./sources/github");
    const { http, calls } = fakeHttp(({ url }) => {
      if (url.includes("/search/issues")) {
        const pr = new URL(url).searchParams.get("q")!.startsWith("is:pull-request");
        return { items: pr
          ? [{ html_url: "", title: "Fix", number: 3, state: "closed", created_at: "2026-10-06T00:00:00Z", closed_at: null, repository_url: "https://api.github.com/repos/me/app", pull_request: {} }]
          : [{ html_url: "", title: "Bug", number: 4, state: "open", created_at: "2026-10-07T00:00:00Z", closed_at: null, repository_url: "https://api.github.com/repos/me/app" }] };
      }
      if (url.includes("/search/commits")) return { items: [{ html_url: "", sha: "abcdef123", commit: { message: "feat: x\n\nbody", author: { date: "2026-10-08T00:00:00Z" } }, repository: { full_name: "me/app" } }] };
      throw new Error(`unexpected ${url}`);
    });
    const r = await github.collect({ ...ctxBase, env: { GITHUB_TOKEN: "t", GITHUB_LOGIN: "me" }, http, from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-12T00:00:00Z") });
    const q = calls.map((c) => new URL(c.url).searchParams.get("q"));
    expect(q).toEqual([
      "is:issue author:me created:2026-10-05T00:00:00Z..2026-10-12T00:00:00Z",
      "is:pull-request author:me created:2026-10-05T00:00:00Z..2026-10-12T00:00:00Z",
      "author:me committer-date:2026-10-05T00:00:00Z..2026-10-12T00:00:00Z",
    ]);
    expect(r.items!.map((i) => github.digest(i))).toEqual([
      "2026-10-07 issue me/app#4 [open] Bug",
      "2026-10-06 pr me/app#3 [closed] Fix",
      "2026-10-08 commit me/app abcdef1 feat: x",
    ]);
  });

  test("health: complete days only, ≤14-day rollup chunks, sleep on the wake-up day, empty days dropped", async () => {
    const { health } = require("./sources/health") as typeof import("./sources/health");
    const bodies: { type: string; range: { start: { date: { day: number; month: number } }; end: { date: { day: number; month: number } } } }[] = [];
    const { http, calls } = fakeHttp(({ url, init }) => {
      if (url === "https://oauth2.googleapis.com/token") return { access_token: "health-tok", expires_in: 3600 };
      const m = /dataTypes\/([a-z-]+)\/dataPoints(:dailyRollUp)?/.exec(url)!;
      if (m[2]) {
        const body = JSON.parse(String(init!.body));
        bodies.push({ type: m[1]!, range: body.range });
        if (m[1] !== "steps") return {};
        return { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 20 } }, civilEndTime: { date: { year: 2026, month: 9, day: 21 } }, steps: { countSum: "4000" } }] };
      }
      expect(new URL(url).searchParams.get("filter")).toBe('sleep.interval.civil_end_time >= "2026-09-15" AND sleep.interval.civil_end_time < "2026-10-12"');
      return { dataPoints: [{ sleep: { interval: { startTime: "2026-09-29T14:00:00Z", endTime: "2026-09-29T21:00:00Z", civilEndTime: { date: { year: 2026, month: 9, day: 30 } } }, summary: { minutesAsleep: "400" } } }] };
    });
    const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HEALTH_REFRESH_TOKEN: "health-refresh", GOOGLE_REFRESH_TOKEN: "general-refresh" };
    const r = await health.collect({ ...ctxBase, env, http, from: new Date(2026, 8, 15, 9), to: new Date(2026, 9, 12, 6, 30) });
    // its own token (the Health API rejects tokens carrying Gmail / Calendar / YouTube scopes)
    expect(String(calls.find((c) => c.url.includes("oauth2"))!.init!.body)).toContain("refresh_token=health-refresh");
    expect(health.configured({ GOOGLE_REFRESH_TOKEN: "x" })).toContain("GOOGLE_HEALTH_REFRESH_TOKEN");
    expect(r.items!.map((d) => (d as { date: string }).date)).toEqual(["2026-09-20", "2026-09-30"]);
    const steps = bodies.filter((b) => b.type === "steps").map((b) => `${b.range.start.date.month}/${b.range.start.date.day}-${b.range.end.date.month}/${b.range.end.date.day}`);
    expect(steps).toEqual(["9/15-9/29", "9/29-10/12"]); // 27 days → 14 + 13
    expect(ymdOf(r.to!)).toBe("2026-10-12");
  });

  test("gmail-review: weekly digest of システム/要確認 (headers only); not due → window stays open; label missing → fails", async () => {
    const { gmailReview, reviewDue, REVIEW_LABEL } = require("./sources/gmail-review") as typeof import("./sources/gmail-review");
    const { http, calls } = fakeHttp(({ url }) => {
      if (url.endsWith("/labels")) return { labels: [{ id: "L9", name: REVIEW_LABEL }, { id: "L1", name: "KB/購入" }] };
      if (/\/messages\?/.test(url)) return { messages: [{ id: "r2" }, { id: "r1" }] };
      const id = /\/messages\/(\w+)\?/.exec(url)![1];
      expect(url).toContain("format=metadata");
      return { id, threadId: `t-${id}`, internalDate: String(Date.parse(id === "r1" ? "2026-10-06T01:00:00Z" : "2026-10-09T01:00:00Z")), payload: { headers: [{ name: "From", value: `shop-${id}@example.test` }, { name: "Subject", value: `件名 ${id}` }] } };
    });
    const env = { GOOGLE_REFRESH_TOKEN: "x" };
    expect(gmailReview.configured(env)).toBe(true);
    expect(gmailReview.configured({ ...env, GMAIL_REVIEW: "off" })).toBe("GMAIL_REVIEW=off");
    expect(gmailReview.configured({ ...env, GMAIL: "off" })).toBe("GMAIL_REVIEW=off");

    // first run: lookback = 7 days → due
    const from = new Date(2026, 9, 5), to = new Date(2026, 9, 12, 6, 30);
    expect(reviewDue(from, to)).toBe(true);
    const r = await gmailReview.collect({ ...ctxBase, env, http, from, to });
    const list = new URL(calls.find((c) => /\/messages\?/.test(c.url))!.url).searchParams;
    expect(list.get("labelIds")).toBe("L9");
    expect(list.get("q")).toBe(`after:${Math.floor(from.getTime() / 1000)} before:${Math.floor(to.getTime() / 1000)}`);
    expect(r.items!.map((i) => gmailReview.digest(i))).toEqual(["2026-10-06 件名 r1 — shop-r1@example.test", "2026-10-09 件名 r2 — shop-r2@example.test"]);
    expect(JSON.stringify(r.items)).not.toContain("body");
    expect(r.meta).toMatchObject({ label: REVIEW_LABEL });

    // the next morning: 1 day since lastTo → nothing fetched, window kept open (to = from)
    calls.length = 0;
    const next = await gmailReview.collect({ ...ctxBase, env, http, from: to, to: new Date(2026, 9, 13, 6, 30) });
    expect(next.items).toBeUndefined();
    expect(next.to).toBe(to);
    expect(calls.length).toBe(0);
    expect(reviewDue(to, new Date(2026, 9, 19, 6, 29))).toBe(true); // 7 calendar days later, launchd a minute early

    const { http: noLabel } = fakeHttp(() => ({ labels: [{ id: "L1", name: "KB/購入" }] }));
    await expect(gmailReview.collect({ ...ctxBase, env, http: noLabel, from, to })).rejects.toThrow(/システム\/要確認 not found/);
  });

  test("gmail-review through runCollectors: lastTo does not advance until the digest is due, then a feed is written", async () => {
    const { gmailReview, REVIEW_LABEL } = require("./sources/gmail-review") as typeof import("./sources/gmail-review");
    const root = mkdtempSync(join(tmpdir(), "kb-review-"));
    const cfg = { root, inbox: join(root, "000_inbox"), cache: join(root, "900_system", "cache") } as unknown as KbConfig;
    const { http } = fakeHttp(({ url }) => {
      if (url.endsWith("/labels")) return { labels: [{ id: "L9", name: REVIEW_LABEL }] };
      if (/\/messages\?/.test(url)) return { messages: [{ id: "r1" }] };
      return { id: "r1", threadId: "t", internalDate: String(Date.parse("2026-10-14T01:00:00Z")), payload: { headers: [{ name: "Subject", value: "件名" }] } };
    });
    const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "x" };
    const log = { info() {}, warn() {} };
    const d1 = await runCollectors(cfg, env, { now: new Date(2026, 9, 12, 6, 30), collectors: [gmailReview], log, http });
    expect(d1[0]!.written).toEqual([feedName("gmail-review", "2026-10-05", "2026-10-12")]);
    expect(loadState(cfg)["gmail-review"]!.lastTo).toBe(new Date(2026, 9, 12, 6, 30).toISOString());
    const d2 = await runCollectors(cfg, env, { now: new Date(2026, 9, 13, 6, 30), collectors: [gmailReview], log, http });
    expect(d2[0]).toMatchObject({ status: "ok", items: 0, written: [] });
    expect(loadState(cfg)["gmail-review"]!.lastTo).toBe(new Date(2026, 9, 12, 6, 30).toISOString()); // unchanged
    const d3 = await runCollectors(cfg, env, { now: new Date(2026, 9, 19, 6, 30), collectors: [gmailReview], log, http });
    expect(d3[0]!.written).toEqual([feedName("gmail-review", "2026-10-12", "2026-10-19")]);
    expect(digestJson(readFileSync(join(cfg.inbox, d3[0]!.written[0]!), "utf8"))).toContain("- 2026-10-14 件名 — ");
  });
});

const ymdOf = (d: Date) => d.toLocaleDateString("sv-SE");

describe("calendar upcoming", () => {
  const { diffUpcoming, calendar } = require("./sources/calendar") as typeof import("./sources/calendar");
  const cal = { id: "primary", summary: "私" };
  const ev = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ id, status: "confirmed", summary: id, updated: "2026-10-01T00:00:00Z", start: { dateTime: start }, end: { dateTime: end }, ...extra });
  const weekly = (n: number, from = 13) => Array.from({ length: n }, (_, i) => ev(`std_${i}`, `2026-10-${String(from + i * 7).padStart(2, "0")}T10:00:00+09:00`, `2026-10-${String(from + i * 7).padStart(2, "0")}T10:30:00+09:00`, { recurringEventId: "std", summary: "定例" }));
  const now = new Date("2026-10-12T06:30:00+09:00");

  test("first run: everything is new, a recurring series is one item", () => {
    const { items, next } = diffUpcoming({}, [ev("trip", "2027-03-01T09:00:00+09:00", "2027-03-03T18:00:00+09:00"), ...weekly(3)].map((event) => ({ cal, event })), now);
    expect(items.map((i) => calendar.digest(i))).toEqual([
      "予定・新規 2027-03-01 09:00–18:00 [私] trip",
      "予定・新規 繰り返し 3 回（2026-10-13〜2026-10-27） 10:00–10:30 [私] 定例",
    ]);
    expect(Object.keys(next).sort()).toEqual(["primary|std", "primary|trip"]);
  });

  test("next run: only changes; a series that merely slid is unchanged; past events are not 'removed'", () => {
    const soon = ev("dentist", "2026-10-12T15:00:00+09:00", "2026-10-12T16:00:00+09:00");
    const { next: prev } = diffUpcoming({}, [soon, ev("trip", "2027-03-01T09:00:00+09:00", "2027-03-03T18:00:00+09:00"), ev("party", "2026-12-24T19:00:00+09:00", "2026-12-24T22:00:00+09:00"), ...weekly(3)].map((event) => ({ cal, event })), now);
    const tomorrow = new Date("2026-10-13T06:30:00+09:00");
    const moved = ev("trip", "2027-03-02T09:00:00+09:00", "2027-03-04T18:00:00+09:00", { updated: "2026-10-12T12:00:00Z" });
    const { items } = diffUpcoming(prev, [moved, ...weekly(3, 20)].map((event) => ({ cal, event })), tomorrow); // dentist happened, party deleted
    expect(items.map((i) => calendar.digest(i))).toEqual([
      "予定・変更 2027-03-02 09:00–18:00 [私] trip",
      "予定・削除 2026-12-24 19:00 [私] party",
    ]);
  });

  test("collect: past window and the 2-year window are fetched separately; the cursor carries the upcoming state", async () => {
    const ranges: string[] = [];
    const http = {
      async fetch(): Promise<Response> { throw new Error("unused"); },
      async json<T>(url: string) {
        if (url.includes("calendarList")) return { items: [{ id: "primary", summary: "私", primary: true, accessRole: "owner" }] } as T;
        const p = new URL(url).searchParams;
        ranges.push(`${p.get("timeMin")!.slice(0, 10)}..${p.get("timeMax")!.slice(0, 10)}`);
        const future = p.get("timeMin")!.startsWith("2026-10-11T21");
        return { items: future ? [ev("trip", "2027-03-01T09:00:00+09:00", "2027-03-03T18:00:00+09:00")] : [ev("mtg", "2026-10-10T10:00:00+09:00", "2026-10-10T11:00:00+09:00")] } as T;
      },
    };
    const google = { configured: true as const, accessToken: async () => "t" };
    const r = await calendar.collect({ cfg: {} as KbConfig, env: { GOOGLE_REFRESH_TOKEN: "x" }, http, google, log: { info() {}, warn() {} }, dryRun: false, cursor: undefined, from: new Date("2026-10-05T00:00:00+09:00"), to: now });
    expect(ranges).toEqual(["2026-10-04..2026-10-11", "2026-10-11..2028-10-11"]);
    expect(r.items!.map((i) => calendar.digest(i))).toEqual(["実績 2026-10-10 10:00–11:00 [私] mtg", "予定・新規 2027-03-01 09:00–18:00 [私] trip"]);
    expect(Object.keys(JSON.parse(r.cursor!).upcoming)).toEqual(["primary|trip"]);
    expect(r.meta).toMatchObject({ horizon: "2028-10-11T21:30:00.000Z", past: 1, upcoming_changes: 1, upcoming_total: 1 });
  });
});

describe("google token lifetime", () => {
  const { tokenExpiry, isExpiredTokenError, createGoogleAuth } = require("./google") as typeof import("./google");
  const issued = "2026-10-12T08:00:00.000Z";

  test("Testing consent screen: 7 days from consent; TTL 0 means no expiry; unknown issue date tracks nothing", () => {
    const e = tokenExpiry({ GOOGLE_REFRESH_TOKEN_ISSUED_AT: issued }, "GOOGLE_REFRESH_TOKEN", new Date("2026-10-18T08:00:00Z"));
    expect(e.expiresAt!.toISOString()).toBe("2026-10-19T08:00:00.000Z");
    expect(e.daysLeft).toBe(1);
    expect(tokenExpiry({ GOOGLE_REFRESH_TOKEN_ISSUED_AT: issued, GOOGLE_TOKEN_TTL_DAYS: "0" }, "GOOGLE_REFRESH_TOKEN").expiresAt).toBeUndefined();
    expect(tokenExpiry({}, "GOOGLE_REFRESH_TOKEN")).toEqual({ issuedAt: undefined });
  });

  test("invalid_grant from the token endpoint becomes an actionable error", async () => {
    expect(isExpiredTokenError('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')).toBe(true);
    expect(isExpiredTokenError("HTTP 403 quota")).toBe(false);
    const http = createHttp({ fetchImpl: (async () => new Response('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', { status: 400 })) as unknown as typeof fetch, sleep: async () => {} });
    const auth = createGoogleAuth({ GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HEALTH_REFRESH_TOKEN: "r" }, http, { refreshTokenVar: "GOOGLE_HEALTH_REFRESH_TOKEN", authCommand: "auth google-health" });
    await expect(auth.accessToken()).rejects.toThrow("GOOGLE_HEALTH_REFRESH_TOKEN expired or revoked (invalid_grant): run bun run collect auth google-health");
  });
});
