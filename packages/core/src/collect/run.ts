/** Orchestrator: run every configured collector in parallel, write their inbox files, keep per-source cursors. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "../config";
import { DAY_MS as DAY, startOfDay, ymd } from "./dates";
import { accountFileName, collectorInstances, splitId, type CollectorInstance } from "./accounts";
import { createGoogleAuth, type GoogleAuth } from "./google";
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

/** `calendar` → collect-calendar-<from>_<to>.json; `calendar@work` → collect-calendar-<from>_<to>@work.json. */
export const feedName = (iid: string, from: string, to: string) => {
  const { id, account } = splitId(iid);
  return accountFileName(`collect-${id}-${from}_${to}.json`, account);
};

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
  // one Google auth per account (the default account's is shared by its Gmail / Calendar / YouTube instances)
  const googleAuths = new Map<string | undefined, GoogleAuth>();
  const googleFor = (inst: CollectorInstance) => {
    let g = googleAuths.get(inst.account);
    if (!g) googleAuths.set(inst.account, (g = createGoogleAuth(inst.env, http, inst.account ? { account: inst.account } : {})));
    return g;
  };
  const state = loadState(cfg);
  const now = opts.now ?? new Date();
  const all = collectorInstances(opts.collectors ?? COLLECTORS, env);
  // `--only calendar` runs that source for every account; `calendar@work` just the one instance
  const matches = (inst: CollectorInstance, name: string) => inst.id === name || inst.collector.id === name;
  const unknown = (opts.only ?? []).filter((name) => !all.some((inst) => matches(inst, name)));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")} (known: ${all.map((c) => c.id).join(", ")})`);
  const selected = opts.only?.length ? all.filter((inst) => opts.only!.some((name) => matches(inst, name))) : all;

  const runOne = async (inst: CollectorInstance): Promise<SourceReport> => {
    const { id, account, collector: c, env } = inst;
    const report: SourceReport = { id, status: "ok", written: [], skippedExisting: [] };
    const ok = c.configured(env);
    if (ok !== true) return { ...report, status: "skipped", reason: ok };
    const st = state[id] ?? {};
    const to = opts.to ?? now;
    const from = opts.from ?? (st.lastTo ? new Date(st.lastTo) : new Date(startOfDay(to).getTime() - c.lookbackDays * DAY));
    let res: CollectResult;
    try {
      res = await c.collect({ cfg, env, account, from, to, cursor: st.cursor, http, google: googleFor(inst), log, dryRun: !!opts.dryRun });
      const f = ymd(res.from ?? from), t = ymd(res.to ?? to);
      Object.assign(report, { from: f, to: t, items: res.count ?? res.items?.length ?? res.files?.length ?? 0 });
      const files = (res.files ?? []).map((file) => ({ ...file, name: accountFileName(file.name, account) }));
      if (res.items?.length) {
        const feed: Feed = { source: c.id, ...(account ? { account } : {}), from: f, to: t, collected_at: now.toISOString(), count: res.items.length, ...(res.meta ? { meta: res.meta } : {}), items: res.items };
        files.push({ name: feedName(id, f, t), json: feed });
      }
      for (const file of files) (writeInbox(cfg, file.name, file.json, !!opts.dryRun) ? report.written : report.skippedExisting).push(file.name);
      if (!opts.dryRun) {
        await res.commit?.();
        state[id] = { cursor: res.cursor ?? st.cursor, lastTo: (res.to ?? to).toISOString(), lastRunAt: now.toISOString(), lastItems: report.items };
      }
      return report;
    } catch (e) {
      // keep the old cursor: the next run retries the same window
      const msg = String((e as Error)?.message ?? e);
      if (!opts.dryRun) state[id] = { ...st, lastRunAt: now.toISOString(), lastError: msg.slice(0, 300) };
      return { ...report, status: "failed", reason: msg };
    }
  };

  const settled = await Promise.allSettled(selected.map(runOne));
  if (!opts.dryRun) saveState(cfg, state);
  return settled.map((s, i) => (s.status === "fulfilled" ? s.value : { id: selected[i]!.id, status: "failed" as const, reason: String(s.reason), written: [], skippedExisting: [] }));
}
