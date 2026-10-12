/**
 * Google Health API (v4): per-day steps / distance / calories / active minutes (dataPoints:dailyRollUp) and sleep
 * sessions (dataPoints list, filtered by wake-up date). Only complete days are collected: [cursor day, today).
 * One item per day; the raw API objects are kept so `kb health import` can recompute anything later.
 */
import { createGoogleAuth, googleJson } from "../google";
import type { Collector } from "../types";
import { startOfDay, ymd } from "../dates";

const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const DAY = 86_400_000;
/** dailyRollUp types; active-minutes / total-calories accept at most 14 days per request. */
export const ROLLUP_TYPES = ["steps", "distance", "total-calories", "active-minutes"] as const;
const CHUNK_DAYS = 14;

interface CivilDateTime { date: { year: number; month: number; day: number }; time?: { hours?: number; minutes?: number } }
export interface RollupPoint { civilStartTime: CivilDateTime; civilEndTime: CivilDateTime; [value: string]: unknown }
export interface SleepPoint { name?: string; sleep: { interval: { startTime: string; endTime: string; civilEndTime?: CivilDateTime }; type?: string; summary?: { minutesAsleep?: string; minutesAwake?: string; minutesInSleepPeriod?: string; stagesSummary?: { type: string; minutes: string }[] } } }
export interface HealthDay { date: string; rollups: Partial<Record<(typeof ROLLUP_TYPES)[number], RollupPoint>>; sleep: SleepPoint[] }

const civil = (d: Date): CivilDateTime => ({ date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } });
export const civilYmd = (c: CivilDateTime) => `${c.date.year}-${String(c.date.month).padStart(2, "0")}-${String(c.date.day).padStart(2, "0")}`;

export const health: Collector = {
  id: "health",
  label: "Google Health",
  lookbackDays: 7,
  configured: (env) => (env.GOOGLE_HEALTH === "off" ? "GOOGLE_HEALTH=off" : env.GOOGLE_HEALTH_REFRESH_TOKEN ? true : "missing GOOGLE_HEALTH_REFRESH_TOKEN (run: bun run collect auth google-health)"),
  async collect({ env, http, from, to }) {
    // its own token: the Health API refuses tokens that also carry Gmail / Calendar / YouTube scopes
    const google = createGoogleAuth(env, http, { refreshTokenVar: "GOOGLE_HEALTH_REFRESH_TOKEN", authCommand: "auth google-health" });
    const start = startOfDay(from);
    const end = startOfDay(to); // exclusive: today is not complete yet
    if (end <= start) return { from: start, to: end };
    const days = new Map<string, HealthDay>();
    for (let t = start.getTime(); t < end.getTime(); t += DAY) days.set(ymd(new Date(t)), { date: ymd(new Date(t)), rollups: {}, sleep: [] });

    for (const type of ROLLUP_TYPES) {
      for (let s = start.getTime(); s < end.getTime(); s += CHUNK_DAYS * DAY) {
        const e = Math.min(s + CHUNK_DAYS * DAY, end.getTime());
        let pageToken: string | undefined;
        do {
          const body = { range: { start: civil(new Date(s)), end: civil(new Date(e)) }, windowSizeDays: 1, ...(pageToken ? { pageToken } : {}) };
          const r = await googleJson<{ rollupDataPoints?: RollupPoint[]; nextPageToken?: string }>(http, google, `${API}/${type}/dataPoints:dailyRollUp`, { method: "POST", body: JSON.stringify(body) });
          for (const p of r.rollupDataPoints ?? []) {
            const day = days.get(civilYmd(p.civilStartTime));
            if (day) day.rollups[type] = p;
          }
          pageToken = r.nextPageToken;
        } while (pageToken);
      }
    }

    // sleep belongs to the day you wake up
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        filter: `sleep.interval.civil_end_time >= "${ymd(start)}" AND sleep.interval.civil_end_time < "${ymd(end)}"`,
        pageSize: "25", ...(pageToken ? { pageToken } : {}),
      });
      const r = await googleJson<{ dataPoints?: SleepPoint[]; nextPageToken?: string }>(http, google, `${API}/sleep/dataPoints?${q}`);
      for (const p of r.dataPoints ?? []) {
        const wake = p.sleep.interval.civilEndTime ? civilYmd(p.sleep.interval.civilEndTime) : ymd(new Date(p.sleep.interval.endTime));
        days.get(wake)?.sleep.push(p);
      }
      pageToken = r.nextPageToken || undefined;
    } while (pageToken);

    const items = [...days.values()].filter((d) => Object.keys(d.rollups).length || d.sleep.length);
    return { items, from: start, to: end };
  },
  digest(item) {
    const m = healthMetrics(item as HealthDay);
    const fmt = (v: number | null, unit: string) => (v === null ? "—" : `${v}${unit}`);
    return `${m.date} 歩数 ${fmt(m.steps, "")} / 睡眠 ${m.sleepMinutes === null ? "—" : `${Math.floor(m.sleepMinutes / 60)}h${String(m.sleepMinutes % 60).padStart(2, "0")}m`} / 活動 ${fmt(m.activeMinutes, "分")} / ${fmt(m.kcal, "kcal")} / ${fmt(m.distanceKm, "km")}`;
  },
};

export interface HealthMetrics { date: string; steps: number | null; distanceKm: number | null; kcal: number | null; activeMinutes: number | null; sleepMinutes: number | null; deepMinutes: number | null; remMinutes: number | null }

const num = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Flatten one collected day into the numbers the health_log table shows. */
export function healthMetrics(d: HealthDay): HealthMetrics {
  const r = d.rollups as Record<string, Record<string, unknown> | undefined>;
  const steps = num((r.steps?.steps as { countSum?: string } | undefined)?.countSum);
  const mm = num((r.distance?.distance as { millimetersSum?: string } | undefined)?.millimetersSum);
  const kcal = num((r["total-calories"]?.totalCalories as { kcalSum?: number } | undefined)?.kcalSum);
  const levels = (r["active-minutes"]?.activeMinutes as { activeMinutesRollupByActivityLevel?: { activityLevel?: string; activeMinutesSum?: string }[] } | undefined)?.activeMinutesRollupByActivityLevel;
  const activeMinutes = levels ? levels.reduce((a, l) => a + (num(l.activeMinutesSum) ?? 0), 0) : null;
  const sum = (f: (p: SleepPoint) => number | null) => (d.sleep.length ? d.sleep.reduce((a, p) => a + (f(p) ?? 0), 0) : null);
  const stage = (t: string) => (p: SleepPoint) => num(p.sleep.summary?.stagesSummary?.find((s) => s.type === t)?.minutes);
  return {
    date: d.date,
    steps,
    distanceKm: mm === null ? null : Math.round(mm / 10_000) / 100,
    kcal: kcal === null ? null : Math.round(kcal),
    activeMinutes,
    sleepMinutes: sum((p) => num(p.sleep.summary?.minutesAsleep)),
    deepMinutes: d.sleep.some((p) => p.sleep.summary?.stagesSummary) ? sum(stage("DEEP")) : null,
    remMinutes: d.sleep.some((p) => p.sleep.summary?.stagesSummary) ? sum(stage("REM")) : null,
  };
}
