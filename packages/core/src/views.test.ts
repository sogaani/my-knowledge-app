import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { replayCalendar } from "./calendar";
import { buildCrossViews, ledgerSpending, logEntries } from "./views";
import type { Feed } from "./collect/types";

const ev = (id: string, start: string, end: string, summary: string, extra: Record<string, unknown> = {}) => ({ id, status: "confirmed", summary, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const feed = (items: unknown[]): Feed<never> => ({ source: "calendar", from: "", to: "", collected_at: "", count: items.length, items: items as never[] });

describe("replayCalendar", () => {
  test("past events, upcoming new / updated / removed, and old feeds without keys", () => {
    const state = replayCalendar([
      // a feed from before `when` existed: plain past events
      feed([{ calendar: "私", calendarId: "p", event: ev("e0", "2026-10-05T10:00:00+09:00", "2026-10-05T11:00:00+09:00", "歯医者") }]),
      feed([
        { when: "upcoming", change: "new", key: "p|trip", calendar: "私", calendarId: "p", event: ev("trip", "2026-11-03T09:00:00+09:00", "2026-11-03T18:00:00+09:00", "京都旅行", { location: "京都" }) },
        { when: "upcoming", change: "new", key: "p|party", calendar: "私", calendarId: "p", event: ev("party", "2026-12-24T19:00:00+09:00", "2026-12-24T22:00:00+09:00", "忘年会") },
        { when: "upcoming", change: "new", key: "p|std", calendar: "仕事", calendarId: "p", event: ev("std_1", "2026-10-13T10:00:00+09:00", "2026-10-13T10:30:00+09:00", "定例", { recurringEventId: "std" }), recurring: { count: 12, first: "2026-10-13T10:00:00+09:00", last: "2026-12-29T10:00:00+09:00" } },
        // removed without a key (feeds before keys were added): matched by calendar, title and start
        { when: "upcoming", change: "new", key: "p|old", calendar: "私", calendarId: "p", event: ev("old", "2026-10-20T10:00:00+09:00", "2026-10-20T11:00:00+09:00", "取消予定") },
      ]),
      feed([
        { when: "upcoming", change: "updated", key: "p|trip", calendar: "私", calendarId: "p", event: ev("trip", "2026-11-04T09:00:00+09:00", "2026-11-04T18:00:00+09:00", "京都旅行") },
        { when: "upcoming", change: "removed", key: "p|party", calendar: "私", calendarId: "p", summary: "忘年会", start: "2026-12-24T19:00:00+09:00" },
        { when: "upcoming", change: "removed", calendar: "私", calendarId: "p", summary: "取消予定", start: "2026-10-20T10:00:00+09:00" },
      ]),
      // the trip happened: the 実績 wins over an older planned entry
      feed([{ when: "past", calendar: "私", calendarId: "p", event: ev("trip", "2026-11-04T09:00:00+09:00", "2026-11-04T18:00:00+09:00", "京都旅行") }]),
    ]);
    const list = [...state.values()].map((e) => `${e.date} ${e.start} ${e.title} ${e.status}${e.recurring ? ` x${e.recurring.count}` : ""}`).sort();
    expect(list).toEqual([
      "2026-10-05 10:00 歯医者 done",
      "2026-10-13 10:00 定例 planned x12",
      "2026-11-04 09:00 京都旅行 done",
    ]);
  });
});

describe("Silver parsers", () => {
  test("ledger spending skips 収入 / 振替 and reads ¥ / commas", () => {
    const body = "## 明細\n\n| 日付 | 内容 | 金額 | 区分 | 支払手段 | 出典 |\n|---|---|---|---|---|---|\n| 2026-10-01 | パン | 450 | 食費 | カード | m |\n| 2026-10-01 | 本 | ¥1,980 | 書籍 | カード | m |\n| 2026-10-02 | 給与 | 300000 | 収入 | 口座 | mt |\n| 2026-10-02 | 移動 | 10000 | 振替 | 口座 | mt |\n\n## 集計\n| 2026-10-03 | x | 1 | 食費 | | |\n";
    expect(ledgerSpending(body)).toEqual([{ date: "2026-10-01", amount: 450 }, { date: "2026-10-01", amount: 1980 }]);
  });
  test("project logs: dated headings and dated bullets", () => {
    const text = "# X — ログ\n\n## 2026-10-11\n- 開始\n- 下調べ\n\n## ログ\n- 2026-10-12: 価格をメモ\n- 日付なし\n";
    expect(logEntries(text)).toEqual([{ date: "2026-10-11", text: "開始" }, { date: "2026-10-11", text: "下調べ" }, { date: "2026-10-12", text: "価格をメモ" }]);
  });
});

describe("cross-domain views", () => {
  test("daily, trends and upcoming are built from Silver notes", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-views-"));
    const w = (rel: string, fm: Record<string, unknown>, body = "") => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}`);
    };
    const base = { status: "open", created: "2026-10-01", updated: "2026-10-12" };
    w("200_silver/210_health/2026-10.md", { ...base, type: "health_log", title: "2026-10", month: "2026-10", avg_steps: 8000, avg_sleep_min: 400, daily: { "2026-10-10": { steps: 8123, sleep_min: 402 } } });
    w("200_silver/211_location/2026-10.md", { ...base, type: "location_log", title: "2026-10", month: "2026-10", type_counts: { bouldering_gym: 3, art_museum: 1, ramen_restaurant: 2, supermarket: 5 }, daily: { "2026-10-10": { visits: 3, places: ["ボルダリングジム X", "ラーメン屋", "スーパー", "駅"], types: ["bouldering_gym"] } } });
    w("200_silver/203_finance/2026-10.md", { ...base, type: "ledger", title: "2026-10", month: "2026-10", total: 2430 }, "\n## 明細\n\n| 日付 | 内容 | 金額 | 区分 | 支払手段 | 出典 |\n|---|---|---|---|---|---|\n| 2026-10-10 | パン | 450 | 食費 | c | m |\n| 2026-10-10 | 本 | 1,980 | 書籍 | c | m |\n");
    w("200_silver/212_calendar/2026-10.md", { ...base, type: "calendar_log", title: "2026-10", month: "2026-10", events: [
      { key: "p|a", date: "2026-10-10", start: "10:00", end: "11:00", title: "歯医者", calendar: "私", status: "done" },
      { key: "p|b", date: "2026-10-20", start: "19:00", end: "21:00", title: "読書会", calendar: "私", location: "渋谷", status: "planned" },
      { key: "p|c", date: "2026-10-13", start: "10:00", end: "10:30", title: "定例", calendar: "仕事", status: "planned", recurring: { count: 12, first: "2026-10-13", last: "2026-12-29" } },
      { key: "p|d", date: "2027-06-01", start: "", end: "", title: "遠い予定", calendar: "私", status: "planned" },
    ] });
    w("200_silver/204_books/本A.md", { ...base, type: "book", title: "本A", status: "read", finished_at: "2026-10-10" });
    w("200_silver/205_media/映画B.md", { ...base, type: "media", title: "映画B", status: "watched", watched_at: "2026-09-15" });
    w("200_silver/206_projects/2026-10_引っ越し/README.md", { ...base, type: "project", title: "引っ越し", status: "active", due: "2026-11-01" });
    writeFileSync(join(root, "200_silver/206_projects/2026-10_引っ越し/log.md"), "# 引っ越し — ログ\n\n## 2026-10-10\n- 内見した\n");
    writeFileSync(join(root, "200_silver/206_projects/2026-10_引っ越し/tasks.md"), "- [ ] 見積もり\n- [x] 内見\n- [ ] 解約連絡\n");
    w("200_silver/206_projects/2026-09_古い/README.md", { ...base, type: "project", title: "古い用事", status: "active", due: "2026-10-01" });
    w("200_silver/202_subscriptions/Netflix.md", { ...base, type: "subscription", title: "Netflix", status: "active", next_renewal: "2026-10-25" });
    w("AGENTS.md", {});
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    delete process.env.KB_DB;
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const pages: Record<string, string> = {};
    buildCrossViews(cfg, db, (rel, text) => { pages[rel] = text; }, { daily: "d", trends: "t", upcoming: "u" }, "2026-10-12");

    expect(pages.d).toContain("| 2026-10-10 | 8,123 | 6h42m | ボルダリングジム X、ラーメン屋、スーパー ほか 1 | ¥2,430 | 歯医者 | 本: [本A](../200_silver/204_books/本A.md) | [引っ越し](../200_silver/206_projects/2026-10_引っ越し/README.md): 内見した |");
    expect(pages.d).toContain("| 2026-09-15 |  |  |  |  |  | 映像: [映画B](../200_silver/205_media/映画B.md) |  |");
    expect(pages.t).toContain("| 運動 | 文化 | 外食 |");
    expect(pages.t).toContain("| 2026-10 | 8,000 | 6h40m | 3 | 1 | 2 | 1 |  | ¥2,430 | 1 |");
    expect(pages.t).toContain("| 2026-09 |  |  |  |  |  |  | 1 |  |  |");
    const u = pages.u!;
    expect(u.indexOf("**2026-10-01（超過）**")).toBeGreaterThan(0);
    expect(u.indexOf("**2026-10-01（超過）**")).toBeLessThan(u.indexOf("| 2026-10-13 | 予定（繰り返し）"));
    expect(u).toContain("| 2026-10-13 | 予定（繰り返し） | 定例（〜2026-12-29、12 回）· 仕事 |");
    expect(u).toContain("| 2026-10-20 | 予定 | 19:00 読書会 @渋谷 · 私 |");
    expect(u).toContain("| 2026-10-25 | 更新 | [Netflix](../200_silver/202_subscriptions/Netflix.md) |");
    expect(u).toContain("| 2026-11-01 | 期限 | [引っ越し](../200_silver/206_projects/2026-10_引っ越し/README.md)（未完了タスク 2） |");
    expect(u).not.toContain("遠い予定"); // beyond 90 days
  });
});
