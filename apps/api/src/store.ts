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
  /** Last sign of life from the worker (claim, log line or explicit heartbeat); requeueStale keys off it. */
  heartbeat_at: string | null;
}
export interface InboxItem { id: string; job_id: string; kind: "url" | "text" | "file"; name: string; path: string | null; url: string | null; text: string | null; created_at: string; fetched: number }
export interface PushSubscriptionRow { endpoint: string; json: string; email: string | null; user_agent: string | null; created_at: string }
export interface ChatMessage { id: string; role: "user" | "assistant"; text: string; sources: string; job_id: string | null; created_at: string }
/** One question and (once the worker's `done` lands) its answer, tied together by the ask job's id. `created_at` is the question's. */
export interface ChatExchange { job_id: string | null; question: ChatMessage; answer: ChatMessage | null; created_at: string }

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
CREATE TABLE IF NOT EXISTS views (path TEXT NOT NULL, viewed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS views_path ON views(path, viewed_at);
CREATE INDEX IF NOT EXISTS chat_role_created ON chat_messages(role, created_at);
`);
// added after the first release: older jobs.sqlite files lack the column
if (!(store.query("PRAGMA table_info(jobs)").all() as { name: string }[]).some((c) => c.name === "heartbeat_at")) store.exec("ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT");

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
  const r = store.query("SELECT id,kind,status,payload,result,log,commit_sha AS 'commit',created_at,started_at,finished_at,heartbeat_at FROM jobs WHERE id=?").get(id) as Job | null;
  return r;
}
export function listJobs(limit = 50): Job[] {
  return store.query("SELECT id,kind,status,payload,result,log,commit_sha AS 'commit',created_at,started_at,finished_at,heartbeat_at FROM jobs WHERE kind != 'search' ORDER BY created_at DESC LIMIT ?").all(limit) as Job[];
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
    const t = now();
    store.run("UPDATE jobs SET status='running', started_at=?, heartbeat_at=? WHERE id=?", [t, t, j.id]);
    return getJob(j.id);
  });
  return tx();
}
/**
 * Claim every queued job of one kind at once (oldest first), so the worker can run them as a single batch: one
 * agent run and one commit for several ingest jobs queued in the same window. Each claimed job gets the same
 * started_at / heartbeat_at as a single claim would.
 */
export function claimQueuedJobs(kind: JobKind, limit = 50): Job[] {
  const tx = store.transaction(() => {
    const ids = (store.query("SELECT id FROM jobs WHERE status='queued' AND kind=? ORDER BY created_at LIMIT ?").all(kind, limit) as { id: string }[]).map((r) => r.id);
    const t = now();
    for (const id of ids) store.run("UPDATE jobs SET status='running', started_at=?, heartbeat_at=? WHERE id=?", [t, t, id]);
    return ids.map((id) => getJob(id)!);
  });
  return tx();
}
export function appendJobLog(id: string, text: string) {
  store.run("UPDATE jobs SET log = log || ?, heartbeat_at=? WHERE id=?", [text, now(), id]);
}
/** The worker is still on it (sent every 30 s while a job runs, since `claude -p` prints nothing until the end). */
export function touchJob(id: string) {
  store.run("UPDATE jobs SET heartbeat_at=? WHERE id=? AND status='running'", [now(), id]);
}
export function finishJob(id: string, ok: boolean, result: unknown, commit?: string | null) {
  store.run("UPDATE jobs SET status=?, result=?, commit_sha=?, finished_at=? WHERE id=?", [ok ? "done" : "failed", JSON.stringify(result ?? null), commit ?? null, now(), id]);
  jobEvents.emit(`done:${id}`);
}
/**
 * Re-queue running jobs whose worker went silent (died, or lost the API) for `maxMinutes`. Silence is measured from the
 * last heartbeat / log line, not from the start, so a long skill run that keeps reporting is never run twice.
 * Jobs claimed by a worker that never sent a heartbeat (older worker) fall back to their start time.
 */
export function requeueStale(maxMinutes = 15, nowMs = Date.now()): number {
  const r = store.run("UPDATE jobs SET status='queued', started_at=NULL, heartbeat_at=NULL WHERE status='running' AND COALESCE(heartbeat_at, started_at) < ?", [new Date(nowMs - maxMinutes * 60000).toISOString()]);
  if (r.changes) jobEvents.emit("queued");
  return r.changes;
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
/**
 * Newest exchanges first, `limit` at a time; `before` (a question's `created_at`) pages further back.
 * A question whose answer has not landed yet comes back with `answer: null`. Rows without a job id are questions on their own.
 */
export function listExchanges(limit = 10, before?: string): ChatExchange[] {
  const qs = (before
    ? store.query("SELECT * FROM chat_messages WHERE role='user' AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit)
    : store.query("SELECT * FROM chat_messages WHERE role='user' ORDER BY created_at DESC LIMIT ?").all(limit)) as ChatMessage[];
  const ids = qs.map((q) => q.job_id).filter((x): x is string => !!x);
  const answers = new Map<string, ChatMessage>();
  if (ids.length) {
    const rows = store.query(`SELECT * FROM chat_messages WHERE role='assistant' AND job_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`).all(...ids) as ChatMessage[];
    for (const r of rows) if (r.job_id && !answers.has(r.job_id)) answers.set(r.job_id, r);
  }
  return qs.map((q) => ({ job_id: q.job_id, question: q, answer: q.job_id ? answers.get(q.job_id) ?? null : null, created_at: q.created_at }));
}

// ---- Note views: one row per note page shown (GET /api/notes/*), so lists can say when a note was last looked at ----
export function recordView(path: string) {
  store.run("INSERT INTO views(path,viewed_at) VALUES(?,?)", [path, now()]);
}
/** Last view per path (ISO), only for paths that were viewed. */
export function lastViewed(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const slice = paths.slice(i, i + 500);
    const rows = store.query(`SELECT path, MAX(viewed_at) AS at FROM views WHERE path IN (${slice.map(() => "?").join(",")}) GROUP BY path`).all(...slice) as { path: string; at: string }[];
    for (const r of rows) out.set(r.path, r.at);
  }
  return out;
}
export function viewCount(path: string): number {
  return (store.query("SELECT COUNT(*) c FROM views WHERE path=?").get(path) as { c: number }).c;
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
