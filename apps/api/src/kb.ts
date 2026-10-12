/** Shared KB handle for the API: config, schema registry, index DB, git sync. */
import { existsSync } from "node:fs";
import {
  loadConfig, openDb, indexNotes, SchemaRegistry, git, gitPull, gitHead, gitCommit, gitPush, gitChangedFiles, gitUnpushed, buildGold, lint,
  LAYOUT, type LintReport,
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
        // Edits a previous pod wrote but never committed are still on the volume: commit them first.
        if (first && (await git(cfg.root, "status", "--porcelain", "--", LAYOUT.silver, LAYOUT.gold))) {
          for (const p of [LAYOUT.silver, LAYOUT.gold]) pending.set(p, "web: commit edits left uncommitted by a restart");
        }
        await flushCommits().catch((e) => console.error(`[sync:${reason}] commit failed:`, (e as Error).message));
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
      if (pushState.unpushed || pending.size) scheduleFlush();
    }
  });
  return syncing as Promise<{ changed: boolean; head: string }>;
}

/**
 * Index web edits right away and answer; the commit and the push to GitHub run in the background
 * (scheduleFlush), batched when several edits arrive close together. `paths` may be files or folders.
 */
export function commitKb(paths: string[], message: string): "queued" | null {
  reindex({ paths });
  if (!isGitRepo) return null;
  for (const p of paths) pending.set(p, message);
  scheduleFlush();
  return "queued";
}

/** Written but not yet committed: repo-relative path → commit message. */
const pending = new Map<string, string>();
/** Commit everything pending as one commit. Runs inside serialGit. On failure the paths stay pending. */
async function flushCommits() {
  if (!pending.size) return;
  const batch = new Map(pending);
  pending.clear();
  const messages = [...new Set(batch.values())];
  const message = messages.length === 1 ? messages[0] : `web: ${messages.length} edits\n\n${messages.map((m) => `- ${m.split("\n")[0]}`).join("\n")}`;
  try {
    const sha = await gitCommit(cfg.root, [...batch.keys()], message, { author: env.gitAuthor });
    if (sha) lastHead = sha;
  } catch (e) {
    for (const [p, m] of batch) if (!pending.has(p)) pending.set(p, m);
    throw e;
  }
}

export const pushState = { unpushed: 0, error: null as string | null };
/** Commits not on GitHub yet plus edits not committed yet (shown on Home). */
export const unsavedCount = () => pushState.unpushed + pending.size;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced commit + push: edits made while one is pending go out together. Retries every minute after a failure. */
function scheduleFlush(delayMs = 300) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    serialGit(async () => {
      const t0 = Date.now();
      try {
        await flushCommits();
        const t1 = Date.now();
        const before = await gitHead(cfg.root);
        const after = await gitPush(cfg.root);
        pushState.unpushed = await gitUnpushed(cfg.root);
        pushState.error = null;
        lastHead = after;
        if (after !== before) await reindexBetween(before, after); // rebased onto commits pushed by the worker
        console.log(`[push] ${after.slice(0, 7)} commit=${t1 - t0}ms push=${Date.now() - t1}ms`);
      } catch (e) {
        pushState.error = (e as Error).message.slice(0, 300);
        console.error("[push] failed:", pushState.error);
        scheduleFlush(60_000);
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
