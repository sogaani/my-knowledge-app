import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { lint } from "./maintain";
import { dueNotes, isStale, onThisDay, renderResurface, renderResurfaceHome, resurface, seededPick } from "./resurface";

const TODAY = "2026-10-13";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-resurface-"));
  const w = (rel: string, fm: Record<string, unknown>, body = "本文\n") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}`);
  };
  const base = { status: "active", created: "2026-01-05", updated: "2026-10-10", summary: "要約" };
  // plaintext notes
  w("200_silver/200_market/銘柄A.md", { ...base, type: "stock", title: "銘柄A", status: "watch", review_due: "2026-10-01" }); // overdue
  w("200_silver/200_market/テーマB.md", { ...base, type: "theme", title: "テーマB", status: "open", review_due: "2026-10-20" }); // within 14 days
  w("200_silver/200_market/テーマC.md", { ...base, type: "theme", title: "テーマC", status: "open", review_due: "2026-12-01" }); // too far
  w("200_silver/201_learning/復習遅れ.md", { ...base, type: "learning", title: "復習遅れ", last_reviewed: "2026-07-01" }); // > 60 days
  w("200_silver/201_learning/復習済み.md", { ...base, type: "learning", title: "復習済み", last_reviewed: "2026-10-01" });
  w("200_silver/201_learning/記録なし.md", { ...base, type: "learning", title: "記録なし", updated: "2026-06-01" }); // no last_reviewed, stale too
  w("200_silver/206_projects/2026-08_放置/README.md", { ...base, type: "project", title: "放置プロジェクト", updated: "2026-09-01" }); // stale (42 days)
  w("200_silver/206_projects/2026-10_進行/README.md", { ...base, type: "project", title: "進行中" });
  w("200_silver/204_books/去年の本.md", { ...base, type: "book", title: "去年の本", status: "read", created: "2025-10-13" }); // on this day
  w("200_silver/204_books/今年の本.md", { ...base, type: "book", title: "今年の本", status: "read", created: "2026-10-13" }); // this year: not "past"
  w("200_silver/208_reviews/2024-10-13.md", { ...base, type: "review", title: "週次 2024-10-13", status: "done", date: "2024-10-13", created: "2024-10-14" }); // `date` wins
  w("200_silver/204_books/_archive/古い.md", { ...base, type: "book", title: "古い本", status: "read", created: "2023-10-13", review_due: "2026-10-01" }); // archived: ignored
  for (let i = 0; i < 6; i++) w(`200_silver/205_media/映画${i}.md`, { ...base, type: "media", title: `映画${i}`, status: "watched" });
  // encrypted domain: a dummy account whose title must never reach the plaintext Gold
  w("200_silver/203_finance/テスト口座.md", { ...base, type: "finance_account", title: "テスト口座", review_due: "2026-09-30" });
  w("200_silver/207_work/2024-10_仕事/README.md", { ...base, type: "project", title: "仕事ノート", status: "done", created: "2024-10-13" });
  w("AGENTS.md", {});
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  const db = openDb(cfg);
  indexNotes(cfg, db);
  return { cfg, db };
}

describe("resurface", () => {
  const { cfg, db } = fixture();
  const r = resurface(db, TODAY);

  test("due: review_due within 14 days (overdue first), learning past 60 days, lint's stale rule; one entry per note", () => {
    expect(r.due.map((e) => [e.title, e.overdue ?? false])).toEqual([
      ["テスト口座", true], ["銘柄A", true],
      ["記録なし", false], ["復習遅れ", false], ["放置プロジェクト", false], ["テーマB", false],
    ]);
    const none = r.due.find((e) => e.title === "記録なし")!;
    expect(none.reason).toBe("復習の記録なし（更新 2026-06-01）・30 日以上更新なし（2026-06-01）");
    expect(r.due.find((e) => e.title === "復習遅れ")!.reason).toBe("最終復習 2026-07-01（104 日前）");
    expect(r.due.find((e) => e.title === "銘柄A")!.reason).toBe("見直し期限 2026-10-01（12 日超過）");
    expect(r.due.find((e) => e.title === "テスト口座")!.encrypted).toBe(true);
    expect(r.due.some((e) => e.title === "テーマC" || e.title === "古い本" || e.title === "復習済み")).toBe(false);
    // the same stale rule lint reports
    expect(lint(cfg, db).stale.length).toBeGreaterThanOrEqual(1);
    expect(isStale({ type: "project", status: "active", updated: "2026-09-01" }, TODAY)).toBe(true);
    expect(isStale({ type: "project", status: "done", updated: "2026-09-01" }, TODAY)).toBe(false);
    expect(isStale({ type: "book", status: "active", updated: "2026-01-01" }, TODAY)).toBe(false);
  });

  test("on this day: created / date on the same month-day in an earlier year, newest first", () => {
    expect(r.onThisDay.map((e) => `${e.reason} ${e.title}`)).toEqual(["2025 年 去年の本", "2024 年 仕事ノート", "2024 年 週次 2024-10-13"]);
    expect(onThisDay([], TODAY)).toEqual([]);
  });

  test("random: three plaintext notes not already listed, the same for the same date", () => {
    expect(r.random).toHaveLength(3);
    const listed = new Set([...r.due, ...r.onThisDay].map((e) => e.path));
    for (const e of r.random) { expect(listed.has(e.path)).toBe(false); expect(e.encrypted).toBe(false); }
    expect(resurface(db, TODAY).random.map((e) => e.path)).toEqual(r.random.map((e) => e.path));
    const other = resurface(db, "2026-10-14").random.map((e) => e.path);
    expect(other).toHaveLength(3);
    // seededPick ignores input order and spreads over types before repeating one
    const items = ["b", "a", "c", "e", "d"].map((path) => ({ path }));
    expect(seededPick(items, "x", 2)).toEqual(seededPick([...items].reverse(), "x", 2));
    expect(new Set(r.random.map((e) => e.type)).size).toBe(3);
    const typed = [...Array.from({ length: 20 }, (_, i) => ({ path: `b${i}`, type: "book" })), { path: "m", type: "media" }, { path: "l", type: "learning" }];
    expect(seededPick(typed, "2026-10-13").map((e) => e.type).sort()).toEqual(["book", "learning", "media"]);
  });

  test("plaintext renderers name no encrypted note: counts per domain only", () => {
    const page = renderResurface(r);
    expect(page).toContain("| **2026-10-01（超過）** | [銘柄A](../200_silver/200_market/銘柄A.md) | 見直し期限 2026-10-01（12 日超過） | 要約 |");
    expect(page).toContain("暗号化ドメイン: 203_finance 1 件");
    expect(page).toContain("- 2025 年: [去年の本](../200_silver/204_books/去年の本.md) — 要約");
    expect(page).toContain("暗号化ドメイン: 207_work 1 件");
    expect(page).not.toContain("テスト口座");
    expect(page).not.toContain("仕事ノート");
    expect(page).not.toContain("203_finance/");
    const home = renderResurfaceHome(r).join("\n");
    expect(home).toContain("[見直し](393_resurface.md) — 期限 6 件（うち暗号化ドメイン 1） / 同じ月日 3 件 / ランダム 3 件");
    expect(home).toContain("- **超過** [銘柄A](../200_silver/200_market/銘柄A.md) — 見直し期限 2026-10-01（12 日超過）");
    expect(home).not.toContain("テスト口座");
    expect(home).not.toContain("仕事ノート");
  });

  test("dueNotes on an empty index", () => {
    expect(dueNotes([], TODAY)).toEqual([]);
  });
});
