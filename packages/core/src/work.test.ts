import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { replayCalendar } from "./calendar";
import { logEntries } from "./views";
import { agenda, collectTasks, dueLabel, glossaryCount, latestWeek, parseTasks, renderWork, workSummary } from "./work";
import type { Feed } from "./collect/types";

describe("parseTasks", () => {
  test("checkboxes with the due lifted out; other lines ignored", () => {
    expect(parseTasks("# T\n\n- [ ] 自己紹介（期限 2026-11-13）\n- [x] 申請 due:2026-11-01\n- [ ] 期限なし\n  - [ ] 子タスク 期限: 2026-11-05\nメモ\n")).toEqual([
      { done: false, text: "自己紹介", due: "2026-11-13", line: 3 },
      { done: true, text: "申請", due: "2026-11-01", line: 4 },
      { done: false, text: "期限なし", line: 5 },
      { done: false, text: "子タスク", due: "2026-11-05", line: 6 },
    ]);
    expect(dueLabel("2026-11-01", "2026-11-03")).toBe("期限切れ 2 日");
    expect(dueLabel("2026-11-03", "2026-11-03")).toBe("今日");
    expect(dueLabel("2026-11-07", "2026-11-03")).toBe("あと 4 日");
  });

  test("log blocks, 1on1 weeks and glossary lines", () => {
    expect(logEntries("## ログ\n- 2026-11-01: 準備\n### 2026-11-02 Onboarding（27 分）\n- 要点 A\n- 要点 B\n### 2026-W45\n- x\n")).toEqual([
      { date: "2026-11-01", text: "準備" }, { date: "2026-11-02", text: "Onboarding（27 分）" },
    ]);
    expect(latestWeek("## 週次\n### 2026-W45（11-02〜11-06）\n- a\n### 2026-W46（11-09〜11-13）\n")).toBe("2026-W46（11-09〜11-13）");
    expect(glossaryCount("- **UPF**: User Plane Function\n- **SIM**: x\n- 普通の行\n")).toBe(2);
  });
});

describe("work view", () => {
  test("work tasks, the work calendar, recent activity; personal projects stay out", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-work-"));
    const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
    const note = (rel: string, fm: Record<string, unknown>) => w(rel, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n`);
    const base = { status: "active", created: "2026-10-01", updated: "2026-11-01", summary: "s" };
    note("200_silver/207_work/2026-10_入社/README.md", { ...base, type: "project", title: "入社", area: "work" });
    w("200_silver/207_work/2026-10_入社/tasks.md", "- [ ] 誓約書（期限 2026-11-01）\n- [ ] 自己紹介（期限 2026-11-05）\n- [ ] GitHub\n- [x] 済み（期限 2026-11-02）\n");
    w("200_silver/207_work/2026-10_入社/log.md", "## ログ\n- 2026-10-20: 古い\n### 2026-11-02 Onboarding\n- 要点\n");
    w("200_silver/207_work/2026-10_入社/1on1.md", "## 週次\n### 2026-W44（10-26〜10-30）\n- a\n");
    w("200_silver/207_work/2026-10_入社/glossary.md", "- **UPF**: x\n");
    note("200_silver/207_work/2026-09_終了/README.md", { ...base, type: "project", title: "終了", status: "done" });
    w("200_silver/207_work/2026-09_終了/tasks.md", "- [ ] 残骸\n");
    note("200_silver/206_projects/2026-10_個人/README.md", { ...base, type: "project", title: "個人" });
    note("200_silver/207_work/2026-10_年金/README.md", { ...base, type: "project", title: "年金", area: "personal" });
    w("200_silver/207_work/2026-10_年金/tasks.md", "- [ ] 移換\n");
    w("200_silver/206_projects/2026-10_個人/tasks.md", "- [ ] 私用（期限 2026-11-04）\n");
    // the work account's events carry account: work (replayCalendar takes it from the feed)
    const ev = (id: string, start: string, summary: string) => ({ id, status: "confirmed", summary, start: { dateTime: start }, end: { dateTime: start.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`) } });
    const feed = (account: string | undefined, items: unknown[]): Feed<never> => ({ source: "calendar", ...(account ? { account } : {}), from: "", to: "", collected_at: "", count: items.length, items: items as never[] });
    const events = [...replayCalendar([
      feed("work", [
        { when: "upcoming", change: "new", key: "w|a", calendar: "ani@co", calendarId: "w", event: ev("a", "2026-11-03T10:00:00+09:00", "1on1") },
        { when: "upcoming", change: "new", key: "w|b", calendar: "ani@co", calendarId: "w", event: ev("b", "2026-11-04T14:00:00+09:00", "研修") },
        { when: "upcoming", change: "new", key: "team@group.calendar.google.com|h", calendar: "Team", calendarId: "team@group.calendar.google.com", event: ev("h", "2026-11-03T13:00:00+09:00", "[誰か]休み") },
        { when: "upcoming", change: "new", key: "w|c", calendar: "ani@co", calendarId: "w", event: ev("c_1", "2026-11-02T09:30:00+09:00", "朝会"), recurring: { count: 40, first: "2026-11-02T09:30:00+09:00", last: "2026-12-25T09:30:00+09:00" } },
      ]),
      feed(undefined, [{ when: "upcoming", change: "new", key: "p|x", calendar: "私", calendarId: "p", event: ev("x", "2026-11-03T19:00:00+09:00", "私用の予定") }]),
    ]).values()];
    expect(events.filter((e) => e.account === "work").length).toBe(4);
    note("200_silver/212_calendar/2026-11.md", { ...base, type: "calendar_log", title: "2026-11 予定", month: "2026-11", events });
    w("AGENTS.md", "");
    process.env.KB_DB = join(root, "kb.sqlite");
    const cfg = loadConfig(root);
    const db = openDb(cfg);
    indexNotes(cfg, db);

    expect(collectTasks(cfg, db, { area: "work" }).map((t) => t.text)).toEqual(["誓約書", "自己紹介", "GitHub"]);
    expect(collectTasks(cfg, db, { area: "personal" }).map((t) => t.text)).toEqual(["私用", "移換"]);
    expect(workSummary(cfg, db, "2026-11-03")).toEqual({ open: 3, overdue: 1, dueSoon: 1, meetingsToday: 1 });
    const { dated, series } = agenda(events.filter((e) => e.account === "work" && !e.key.includes("@group.")), "2026-11-03");
    expect(dated.map((e) => e.title)).toEqual(["1on1", "研修"]);
    expect(series.map((e) => e.title)).toEqual(["朝会"]);

    const md = renderWork(cfg, db, "2026-11-03");
    expect(md).toContain("| **2026-11-01** | 期限切れ 2 日 | 誓約書 |");
    expect(md).toContain("| 2026-11-05 | あと 2 日 | 自己紹介 |");
    expect(md).toContain("| 今日 | 10:00–11:00 | 1on1 |");
    expect(md).toContain("定例（期間中。実際の日は Google カレンダーで）: 09:30 朝会");
    expect(md).toContain("- GitHub");
    expect(md).toContain("| 2026-11-02 |");
    expect(md).toContain("2026-W44（10-26〜10-30）");
    expect(md).toContain("1 語");
    for (const s of ["私用", "残骸", "古い", "済み", "休み", "移換", "年金"]) expect(md).not.toContain(s);
  });
});
