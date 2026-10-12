import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";

export type JobKind = "ingest" | "ask" | "recommend" | "skill" | "search";
export type JobStatus = "queued" | "running" | "done" | "failed";
export interface Job {
  id: string; kind: JobKind; status: JobStatus; payload: string; result: string | null; log: string;
  commit: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface InboxItem { id: string; job_id: string; kind: "url" | "text" | "file"; name: string; path: string | null; url: string | null; text: string | null; created_at: string; fetched: number }
export interface PushSubscriptionRow { endpoint: string; json: string; email: string | null; user_agent: string | null; created_at: string }
export interface ChatMessage { id: string; role: "user" | "assistant"; text: string; sources: string; job_id: string | null; created_at: string }

mkdirSync(env.dataDir, { recursive: true });
mkdirSync(join(env.dataDir, "staging"), { recursive: true });
export const store = new Database(join(env.dataDir, "jobs.sqlite"));
store.exec("PRAGMA journal_mode=WAL");
store.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, log TEXT DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT, url TEXT, text TEXT,
  created_at TEXT NOT NULL, fetched INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, sources TEXT DEFAULT '[]', job_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, email TEXT, user_agent TEXT, created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/** In-process wakeups so long-polls answer as soon as a job is queued or finished (instead of sleep-polling SQLite). */
const jobEvents = new EventEmitter().setMaxListeners(0);
/** Resolves when `event` fires or after `ms`, whichever comes first. */
export function waitJobEvent(event: "queued" | `done:${string}`, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(t); jobEvents.off(event, done); resolve(); }
    jobEvents.once(event, done);
  });
}

export function createJob(kind: JobKind, payload: unknown, id = newId()): Job {
  store.run("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES(?,?,?,?,?)", [id, kind, "queued", JSON.stringify(payload), now()]);
  jobEvents.emit("queued");
  return getJob(id)!;
}
export function getJob(id: string): Job | null {
  const r = store.query("SELECT id,kind,status,payload,result,log,commit_sha AS 'commit',created_at,started_at,finished_at FROM jobs WHERE id=?").get(id) as Job | null;
  return r;
}
export function listJobs(limit = 50): Job[] {
  return store.query("SELECT id,kind,status,payload,result,log,commit_sha AS 'commit',created_at,started_at,finished_at FROM jobs WHERE kind != 'search' ORDER BY created_at DESC LIMIT ?").all(limit) as Job[];
}
/** Search jobs are ephemeral: drop finished ones after a while so the queue table stays small. */
export function pruneSearchJobs(maxMinutes = 60) {
  store.run("DELETE FROM jobs WHERE kind='search' AND status IN ('done','failed') AND finished_at < ?", [new Date(Date.now() - maxMinutes * 60000).toISOString()]);
}
/** Atomically claim the oldest queued job, optionally only of the given kinds. */
export function claimNextJob(kinds?: string[]): Job | null {
  const tx = store.transaction(() => {
    const only = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const j = store.query(`SELECT id FROM jobs WHERE status='queued'${only} ORDER BY created_at LIMIT 1`).get(...(kinds ?? [])) as { id: string } | null;
    if (!j) return null;
    store.run("UPDATE jobs SET status='running', started_at=? WHERE id=?", [now(), j.id]);
    return getJob(j.id);
  });
  return tx();
}
export function appendJobLog(id: string, text: string) {
  store.run("UPDATE jobs SET log = log || ? WHERE id=?", [text, id]);
}
export function finishJob(id: string, ok: boolean, result: unknown, commit?: string | null) {
  store.run("UPDATE jobs SET status=?, result=?, commit_sha=?, finished_at=? WHERE id=?", [ok ? "done" : "failed", JSON.stringify(result ?? null), commit ?? null, now(), id]);
  jobEvents.emit(`done:${id}`);
}
/** Re-queue jobs stuck in running for too long (worker died). */
export function requeueStale(maxMinutes = 60) {
  const r = store.run("UPDATE jobs SET status='queued', started_at=NULL WHERE status='running' AND started_at < ?", [new Date(Date.now() - maxMinutes * 60000).toISOString()]);
  if (r.changes) jobEvents.emit("queued");
}

export function addInboxItem(it: Omit<InboxItem, "created_at" | "fetched">) {
  store.run("INSERT INTO inbox_items(id,job_id,kind,name,path,url,text,created_at) VALUES(?,?,?,?,?,?,?,?)", [it.id, it.job_id, it.kind, it.name, it.path, it.url, it.text, now()]);
}
/** True when a file of this name was already staged (idempotent pushes from Gmail: the name embeds the message id). */
export function inboxItemNameExists(name: string): boolean {
  return !!store.query("SELECT 1 FROM inbox_items WHERE name=? LIMIT 1").get(name);
}
export function inboxItemsForJob(jobId: string): InboxItem[] {
  return store.query("SELECT * FROM inbox_items WHERE job_id=?").all(jobId) as InboxItem[];
}
export function getInboxItem(id: string): InboxItem | null {
  return store.query("SELECT * FROM inbox_items WHERE id=?").get(id) as InboxItem | null;
}
export function markInboxFetched(id: string) {
  store.run("UPDATE inbox_items SET fetched=1 WHERE id=?", [id]);
}

export function addChat(role: ChatMessage["role"], text: string, jobId: string | null, sources: string[] = []): ChatMessage {
  const id = newId();
  store.run("INSERT INTO chat_messages(id,role,text,sources,job_id,created_at) VALUES(?,?,?,?,?,?)", [id, role, text, JSON.stringify(sources), jobId, now()]);
  return store.query("SELECT * FROM chat_messages WHERE id=?").get(id) as ChatMessage;
}
export function listChat(limit = 100): ChatMessage[] {
  return (store.query("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?").all(limit) as ChatMessage[]).reverse();
}

// ---- Web Push subscriptions (one row per browser; the endpoint is the identity) ----
export function addPushSubscription(sub: { endpoint: string }, email: string | null, userAgent: string | null) {
  store.run("INSERT INTO push_subscriptions(endpoint,json,email,user_agent,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET json=excluded.json, email=excluded.email, user_agent=excluded.user_agent",
    [sub.endpoint, JSON.stringify(sub), email, userAgent, now()]);
}
export function listPushSubscriptions(): PushSubscriptionRow[] {
  return store.query("SELECT endpoint,json,email,user_agent,created_at FROM push_subscriptions ORDER BY created_at").all() as PushSubscriptionRow[];
}
export function deletePushSubscription(endpoint: string) {
  store.run("DELETE FROM push_subscriptions WHERE endpoint=?", [endpoint]);
}
