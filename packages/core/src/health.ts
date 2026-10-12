/**
 * `kb health import <bronze-id>`: turn collect-health-*.json feeds into monthly `health_log` notes (200_silver/210_health).
 * Each touched month is rebuilt from every health feed in Bronze (newer captures win per day), so re-collected
 * days just overwrite and nothing is parsed back out of the Markdown table.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { bronzeDir, markProcessed, readMeta, walkBronze } from "./bronze";
import { createNote } from "./create";
import { parseNote, stringifyNote } from "./frontmatter";
import { runQuery } from "./query";
import type { SchemaRegistry } from "./schema";
import { healthMetrics, type HealthDay, type HealthMetrics } from "./collect/sources/health";
import type { Feed } from "./collect/types";

const BEGIN = "<!-- kb:health:start -->";
const END = "<!-- kb:health:end -->";
const isHealthFeed = (f: string) => /^collect-health-.*\.json$/.test(f);

function readFeed(cfg: KbConfig, id: string): Feed<HealthDay> | null {
  const meta = readMeta(cfg, id);
  const f = meta?.files.find(isHealthFeed);
  if (!meta || !f) return null;
  return JSON.parse(readFileSync(join(bronzeDir(cfg, id), f), "utf8")) as Feed<HealthDay>;
}

const hm = (min: number | null) => (min === null ? "-" : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`);
const n = (v: number | null, digits = 0) => (v === null ? "-" : v.toLocaleString("ja-JP", { maximumFractionDigits: digits }));
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

export function renderHealthTable(days: HealthMetrics[]): string {
  return [
    BEGIN,
    "_Google Health から自動生成（`kb health import` が書き換える区間。メモは下の `## メモ` に書く）_", "",
    "| 日付 | 歩数 | 睡眠 | 深い睡眠 | REM | 活動[分] | 消費[kcal] | 距離[km] |",
    "|---|---|---|---|---|---|---|---|",
    ...days.map((d) => `| ${d.date} | ${n(d.steps)} | ${hm(d.sleepMinutes)} | ${hm(d.deepMinutes)} | ${hm(d.remMinutes)} | ${n(d.activeMinutes)} | ${n(d.kcal)} | ${n(d.distanceKm, 2)} |`),
    "",
    `- 平均: 歩数 ${n(avg(days.map((d) => d.steps)))} / 睡眠 ${hm(avg(days.map((d) => d.sleepMinutes)))} / 活動 ${n(avg(days.map((d) => d.activeMinutes)))} 分`,
    END,
  ].join("\n");
}

export interface ImportHealthResult { months: { path: string; created: boolean; days: number }[]; bronzeId: string }

export function importHealth(cfg: KbConfig, reg: SchemaRegistry, db: Database, bronzeId: string): ImportHealthResult {
  const feed = readFeed(cfg, bronzeId);
  if (!feed) throw new Error(`${bronzeId} is not a collect-health feed in Bronze`);
  if (!reg.get("health_log")) throw new Error("schema health_log.json missing");
  const months = [...new Set(feed.items.map((d) => d.date.slice(0, 7)))].sort();

  // every health feed in Bronze, oldest capture first, so later captures overwrite a day
  const feeds = [...walkBronze(cfg)]
    .filter((m) => m.kind === "feed" && m.files.some(isHealthFeed))
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at));

  const out: ImportHealthResult["months"] = [];
  for (const month of months) {
    const byDay = new Map<string, HealthDay>();
    const contributing: string[] = [];
    for (const m of feeds) {
      const f = readFeed(cfg, m.id);
      const inMonth = f?.items.filter((d) => d.date.startsWith(month)) ?? [];
      if (!inMonth.length) continue;
      contributing.push(m.id);
      for (const d of inMonth) byDay.set(d.date, d);
    }
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(healthMetrics);

    const existing = runQuery(db, { filters: [{ field: "type", op: "=", value: "health_log" }, { field: "month", op: "=", value: month }] })[0];
    let rel = existing?.path, created = false;
    if (!rel || !existsSync(join(cfg.root, rel))) {
      rel = createNote(cfg, reg, db, { type: "health_log", title: month, set: { month } });
      created = true;
    }
    const abs = join(cfg.root, rel);
    const { fm, body } = parseNote(readFileSync(abs, "utf8"));
    const block = renderHealthTable(days);
    const b = body.indexOf(BEGIN), e = body.indexOf(END);
    let newBody: string;
    if (b !== -1 && e > b) newBody = body.slice(0, b) + block + body.slice(e + END.length);
    else {
      const h = /^## 日別\s*\n/m.exec(body) ?? /^# .*\n/m.exec(body);
      const at = h ? h.index + h[0].length : 0;
      newBody = body.slice(0, at) + "\n" + block + "\n" + body.slice(at);
    }
    const avgSteps = avg(days.map((d) => d.steps)), avgSleep = avg(days.map((d) => d.sleepMinutes));
    // machine-readable per-day values for the cross-domain Gold views (390_daily / 391_trends); the table is for people
    const daily = Object.fromEntries(days.map((d) => [d.date, Object.fromEntries(Object.entries({
      steps: d.steps, sleep_min: d.sleepMinutes, deep_min: d.deepMinutes, rem_min: d.remMinutes, active_min: d.activeMinutes, kcal: d.kcal, km: d.distanceKm,
    }).filter(([, v]) => v !== null))]));
    Object.assign(fm, {
      month, days: days.length, daily,
      ...(avgSteps !== null ? { avg_steps: avgSteps } : {}),
      ...(avgSleep !== null ? { avg_sleep_min: avgSleep } : {}),
      summary: `${month.replace("-", "年").replace(/^(\d+年)0?/, "$1")}月の健康記録（${days.length} 日・平均歩数 ${n(avgSteps)}・平均睡眠 ${hm(avgSleep)}）`,
      updated: today(),
    });
    fm.sources = [...new Set([...(Array.isArray(fm.sources) ? fm.sources.map(String) : []), ...contributing])];
    writeFileSync(abs, stringifyNote(fm, newBody));
    markProcessed(cfg, bronzeId, [rel]);
    out.push({ path: rel, created, days: days.length });
  }
  if (!months.length) markProcessed(cfg, bronzeId, ["-"]);
  return { months: out, bronzeId };
}
