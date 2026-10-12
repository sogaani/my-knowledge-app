/** Shared KB handle for the API: config, schema registry, index DB, git sync. */
import { existsSync } from "node:fs";
import {
  loadConfig, openDb, indexNotes, SchemaRegistry, gitPull, gitHead, gitCommit, gitPush, gitChangedFiles, gitUnpushed, buildGold, lint,
  type LintReport,
} from "@kb/core";
import { env } from "./env";

process.env.KB_ROOT = env.kbRoot;
export const cfg = loadConfig(env.kbRoot);
export const reg = new SchemaRegistry(cfg);
export const db = openDb(cfg);

export const isGitRepo = existsSync(`${cfg.root}/.git`);
let lastHead = "";
let syncing: Promise<unknown> | null = null;

/** Full walk, or only the given repo-relative files/folders. */
export function reindex(opts: { full?: boolean; paths?: string[] } = {}) {
  lintCache = null;
  return indexNotes(cfg, db, opts);
}

/** Every git command on the checkout runs through this queue: sync, web commits and the background push never overlap. */
let gitQueue: Promise<unknown> = Promise.resolve();
function serialGit<T>(f: () => Promise<T>): Promise<T> {
  const p = gitQueue.then(f, f);
  gitQueue = p.catch(() => {});
  return p;
}

/** Re-index what changed between two commits (a pull or a rebase during push). */
async function reindexBetween(before: string, after: string) {
  const paths = await gitChangedFiles(cfg.root, before, after).catch(() => null);
  return paths ? reindex({ paths }) : reindex();
}

/** git pull (rebase onto any unpushed web commits) + reindex of the changed files. Safe to call concurrently. */
export async function sync(reason: string): Promise<{ changed: boolean; head: string }> {
  if (syncing) { await syncing; return { changed: false, head: lastHead }; }
  syncing = serialGit(async () => {
    try {
      if (isGitRepo) {
        // The index DB lives in an emptyDir and is empty on every start: the first sync must always index,
        // even when the pull brings nothing new (this used to be checked after lastHead was already set).
        const first = !lastHead;
        const { before, after } = await gitPull(cfg.root, { rebase: true });
        lastHead = after;
        pushState.unpushed = await gitUnpushed(cfg.root); // also picks up commits a previous pod could not push
        if (before !== after || first) {
          const r = first ? reindex({ full: true }) : await reindexBetween(before, after);
          console.log(`[sync:${reason}] ${before.slice(0, 7)} -> ${after.slice(0, 7)}${first ? " (full)" : ""}`, r);
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
      if (pushState.unpushed) schedulePush();
    }
  });
  return syncing as Promise<{ changed: boolean; head: string }>;
}

/**
 * Commit web edits locally and answer right away; the push to GitHub runs in the background (see schedulePush).
 * `paths` may be files or folders.
 */
export async function commitKb(paths: string[], message: string): Promise<string | null> {
  if (!isGitRepo) { reindex({ paths }); return null; }
  const sha = await serialGit(() => gitCommit(cfg.root, paths, message, { author: env.gitAuthor }));
  reindex({ paths });
  if (sha) { lastHead = sha; pushState.unpushed++; schedulePush(); }
  return sha;
}

export const pushState = { unpushed: 0, error: null as string | null };
let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced: commits made while a push is pending go out together. Retries every minute after a failure. */
function schedulePush(delayMs = 300) {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    serialGit(async () => {
      const t0 = Date.now();
      try {
        const before = await gitHead(cfg.root);
        const after = await gitPush(cfg.root);
        pushState.unpushed = await gitUnpushed(cfg.root);
        pushState.error = null;
        lastHead = after;
        if (after !== before) await reindexBetween(before, after); // rebased onto commits pushed by the worker
        console.log(`[push] ${after.slice(0, 7)} ${Date.now() - t0}ms`);
      } catch (e) {
        pushState.error = (e as Error).message.slice(0, 300);
        console.error("[push] failed:", pushState.error);
        schedulePush(60_000);
      }
    });
  }, delayMs);
}

export function head(): string {
  return lastHead;
}

/** lint reads the inbox and every bronze meta: keep the result until the index changes (or 5 minutes pass). */
let lintCache: { at: number; report: LintReport } | null = null;
export function cachedLint(): LintReport {
  if (!lintCache || Date.now() - lintCache.at > 5 * 60_000) lintCache = { at: Date.now(), report: lint(cfg, db) };
  return lintCache.report;
}

export function rebuildGold() {
  const files = buildGold(cfg, db);
  reindex();
  return files;
}
