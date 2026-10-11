/** Shared KB handle for the API: config, schema registry, index DB, git sync. */
import { existsSync } from "node:fs";
import { loadConfig, openDb, indexNotes, SchemaRegistry, gitPull, gitHead, buildGold } from "@kb/core";
import { env } from "./env";

process.env.KB_ROOT = env.kbRoot;
export const cfg = loadConfig(env.kbRoot);
export const reg = new SchemaRegistry(cfg);
export const db = openDb(cfg);

export const isGitRepo = existsSync(`${cfg.root}/.git`);
let lastHead = "";
let syncing: Promise<unknown> | null = null;

export function reindex(full = false) {
  return indexNotes(cfg, db, { full });
}

/** git pull (ff-only) + incremental reindex. Safe to call concurrently. */
export async function sync(reason: string): Promise<{ changed: boolean; head: string }> {
  if (syncing) { await syncing; return { changed: false, head: lastHead }; }
  syncing = (async () => {
    try {
      if (isGitRepo) {
        const { before, after } = await gitPull(cfg.root);
        lastHead = after;
        if (before !== after || !lastHead) {
          const r = reindex();
          console.log(`[sync:${reason}] ${before.slice(0, 7)} -> ${after.slice(0, 7)}`, r);
          return { changed: true, head: after };
        }
        return { changed: false, head: after };
      }
      reindex();
      return { changed: true, head: "" };
    } catch (e) {
      console.error(`[sync:${reason}] failed:`, (e as Error).message);
      return { changed: false, head: lastHead };
    } finally {
      syncing = null;
    }
  })();
  return syncing as Promise<{ changed: boolean; head: string }>;
}

export async function head(): Promise<string> {
  return isGitRepo ? gitHead(cfg.root) : "";
}

export function rebuildGold() {
  const files = buildGold(cfg, db);
  reindex();
  return files;
}
