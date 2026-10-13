/** Orchestrator: run every configured collector in parallel, write their inbox files, keep per-source cursors. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "../config";
import { DAY_MS as DAY, startOfDay, ymd } from "./dates";
import { createGoogleAuth } from "./google";
import { createHttp, type HttpClient } from "./http";
import { COLLECTORS } from "./registry";
import type { Collector, CollectResult, Env, Feed, Logger } from "./types";

/** `lastItems`: feed entries / files written by the last successful run (the morning digest reports it). */
export interface SourceState { cursor?: string; lastTo?: string; lastRunAt?: string; lastError?: string; lastItems?: number }
export type CollectState = Record<string, SourceState>;

export interface SourceReport {
  id: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  from?: string;
  to?: string;
  items?: number;
  written: string[];
  skippedExisting: string[];
}


export const statePath = (cfg: KbConfig) => join(cfg.cache, "collect-state.json");

export function loadState(cfg: KbConfig): CollectState {
  const p = statePath(cfg);
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CollectState) : {}; } catch { return {}; }
}

function saveState(cfg: KbConfig, s: CollectState) {
  mkdirSync(cfg.cache, { recursive: true });
  const p = statePath(cfg);
  writeFileSync(`${p}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${p}.tmp`, p);
}

/** Write one inbox file unless a file of that name is already waiting there (same window collected twice). */
function writeInbox(cfg: KbConfig, name: string, json: unknown, dryRun: boolean): boolean {
  const p = join(cfg.inbox, name);
  if (existsSync(p)) return false;
  if (!dryRun) {
    mkdirSync(cfg.inbox, { recursive: true });
    writeFileSync(`${p}.part`, JSON.stringify(json, null, 2));
    renameSync(`${p}.part`, p); // ingest never sees a half-written file
  }
  return true;
}

export const feedName = (id: string, from: string, to: string) => `collect-${id}-${from}_${to}.json`;

export interface RunOpts {
  only?: string[];
  from?: Date;
  to?: Date;
  dryRun?: boolean;
  log?: Logger;
  http?: HttpClient;
  collectors?: Collector[];
  now?: Date;
}

export async function runCollectors(cfg: KbConfig, env: Env, opts: RunOpts = {}): Promise<SourceReport[]> {
  const log = opts.log ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const http = opts.http ?? createHttp({ onRetry: (m) => log.warn(`  ${m}`) });
  const google = createGoogleAuth(env, http);
  const state = loadState(cfg);
  const now = opts.now ?? new Date();
  const all = opts.collectors ?? COLLECTORS;
  const unknown = (opts.only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")} (known: ${all.map((c) => c.id).join(", ")})`);
  const selected = opts.only?.length ? all.filter((c) => opts.only!.includes(c.id)) : all;

  const runOne = async (c: Collector): Promise<SourceReport> => {
    const report: SourceReport = { id: c.id, status: "ok", written: [], skippedExisting: [] };
    const ok = c.configured(env);
    if (ok !== true) return { ...report, status: "skipped", reason: ok };
    const st = state[c.id] ?? {};
    const to = opts.to ?? now;
    const from = opts.from ?? (st.lastTo ? new Date(st.lastTo) : new Date(startOfDay(to).getTime() - c.lookbackDays * DAY));
    let res: CollectResult;
    try {
      res = await c.collect({ cfg, env, from, to, cursor: st.cursor, http, google, log, dryRun: !!opts.dryRun });
      const f = ymd(res.from ?? from), t = ymd(res.to ?? to);
      Object.assign(report, { from: f, to: t, items: res.count ?? res.items?.length ?? res.files?.length ?? 0 });
      const files = [...(res.files ?? [])];
      if (res.items?.length) {
        const feed: Feed = { source: c.id, from: f, to: t, collected_at: now.toISOString(), count: res.items.length, ...(res.meta ? { meta: res.meta } : {}), items: res.items };
        files.push({ name: feedName(c.id, f, t), json: feed });
      }
      for (const file of files) (writeInbox(cfg, file.name, file.json, !!opts.dryRun) ? report.written : report.skippedExisting).push(file.name);
      if (!opts.dryRun) {
        await res.commit?.();
        state[c.id] = { cursor: res.cursor ?? st.cursor, lastTo: (res.to ?? to).toISOString(), lastRunAt: now.toISOString(), lastItems: report.items };
      }
      return report;
    } catch (e) {
      // keep the old cursor: the next run retries the same window
      const msg = String((e as Error)?.message ?? e);
      if (!opts.dryRun) state[c.id] = { ...st, lastRunAt: now.toISOString(), lastError: msg.slice(0, 300) };
      return { ...report, status: "failed", reason: msg };
    }
  };

  const settled = await Promise.allSettled(selected.map(runOne));
  if (!opts.dryRun) saveState(cfg, state);
  return settled.map((s, i) => (s.status === "fulfilled" ? s.value : { id: selected[i]!.id, status: "failed" as const, reason: String(s.reason), written: [], skippedExisting: [] }));
}
