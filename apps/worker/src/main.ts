#!/usr/bin/env bun
/**
 * Mac-side agent worker: long-polls the API for jobs and runs them against the local KB checkout
 * with the agent CLI chosen by KB_AGENT (claude|codex|gemini). Never exposes a port.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  LAYOUT, SILVER_PREFIX, SIMILAR_REL, ARTICLES_DIR, loadConfig, git, gitCommitPush, gitStatusPaths, hasUpstream, openDb, indexNotes, parseFilters, search, makeEmbedder, listInbox,
  clipError, errorHead, buildOpsDigest, formatOpsDigest, renderOpsDigest, type SearchMode,
} from "@kb/core";
import { planIngest, ingestCommitMessage, ingestDoneBodies, ingestFailureBodies, type IngestOutcome } from "./ingest-batch";

const API = (process.env.KB_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const cfg = loadConfig(process.env.KB_ROOT);
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.WORKER_TOKEN) headers.authorization = `Bearer ${process.env.WORKER_TOKEN}`;
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
}
/** worker.log lines carry a timestamp; API errors are clipped to the status and the head of the body (never a whole Cloudflare error page). */
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const info = (m: string) => console.log(`${stamp()} ${m}`);
const warn = (m: string) => console.error(`${stamp()} ${m}`);
/** Sent while a job runs so the API's requeueStale sees a live worker even when the agent prints nothing for minutes. */
const HEARTBEAT_MS = 30_000;

interface Job { id: string; kind: string; payload: string; inbox?: { id: string; kind: "url" | "text" | "file"; name: string }[] }

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/api/worker${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${clipError(await res.text())}`);
  return res;
}
const log = (id: string, text: string) => api(`/jobs/${id}/log`, { method: "POST", body: text, headers: { "content-type": "text/plain" } }).catch(() => {});

/** Run run-agent.sh and stream its output to the job log. Returns full stdout. */
function runAgent(jobId: string, args: string[]): Promise<{ out: string; code: number }> {
  return streamed(jobId, ["bash", join(cfg.root, LAYOUT.system, "scripts", "run-agent.sh"), ...args]);
}
/** `kb` with its stdout and stderr streamed to the job log (for commands that run an agent themselves). Returns stdout only. */
function kbStreamed(jobId: string, args: string[]): Promise<{ out: string; code: number }> {
  return streamed(jobId, ["bun", "run", join(import.meta.dir, "../../cli/src/main.ts"), ...args]);
}
async function streamed(jobId: string, cmd: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(cmd, { cwd: cfg.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, KB_ROOT: cfg.root } });
  let out = "", buf = "";
  const flush = setInterval(() => { if (buf) { log(jobId, buf); buf = ""; } }, 2000);
  const pump = async (s: ReadableStream<Uint8Array>, keep: boolean) => { for await (const chunk of s) { const t = new TextDecoder().decode(chunk); if (keep) out += t; buf += t; } };
  await Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]);
  const code = await proc.exited;
  clearInterval(flush);
  if (buf) await log(jobId, buf);
  return { out, code };
}

async function kb(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../../cli/src/main.ts"), ...args], { cwd: cfg.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, KB_ROOT: cfg.root } });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`kb ${args[0]}: ${e || o}`);
  return o;
}

/** Silver, Gold and the similar-notes pairs `kb build` (→ embed) rewrote: the API pod reads them from git. */
async function commitAll(message: string): Promise<string | null> {
  const paths = [LAYOUT.silver, LAYOUT.gold, ...[SIMILAR_REL, ARTICLES_DIR].filter((p) => existsSync(join(cfg.root, p)))];
  return gitCommitPush(cfg.root, paths, message, { author: "kb-worker <kb-worker@local>" });
}

async function stageInbox(job: Job) {
  mkdirSync(cfg.inbox, { recursive: true });
  for (const it of job.inbox ?? []) {
    const res = await api(`/inbox/${it.id}`);
    if (!res) continue;
    if (it.kind === "url") {
      const { url } = (await res.json()) as { url: string };
      writeFileSync(join(cfg.inbox, `url-${it.id.slice(0, 8)}.md`), `${url}\n`);
    } else {
      writeFileSync(join(cfg.inbox, it.name), new Uint8Array(await res.arrayBuffer()));
    }
  }
}

/** Kept open across search jobs (the search lane is the only user in this process). */
let searchDb: ReturnType<typeof openDb> | undefined;
let embedder: ReturnType<typeof makeEmbedder> | undefined;

const parsePayload = (job: Job) => JSON.parse(job.payload || "{}") as Record<string, unknown>;
const short = (id: string) => id.slice(0, 8);

async function handle(job: Job) {
  const payload = parsePayload(job);
  info(`[job ${short(job.id)}] ${job.kind}${payload.scheduled ? " (scheduled)" : ""}`);
  if (job.kind === "ingest") return handleIngest(job);
  const heartbeat = job.kind === "search" ? null : setInterval(() => api(`/jobs/${job.id}/heartbeat`, { method: "POST" }).catch(() => {}), HEARTBEAT_MS);
  try {
    await run(job, payload);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** Every ingest job queued right now, so one agent run covers them all. An API without the route (older) yields none. */
async function claimQueued(kind: string): Promise<Job[]> {
  try {
    const res = await api(`/jobs/claim?kind=${kind}`, { method: "POST" });
    return res ? ((await res.json()) as { jobs: Job[] }).jobs : [];
  } catch (e) {
    warn(`claim ${kind}: ${(e as Error).message}`);
    return [];
  }
}

async function handleIngest(lead: Job) {
  const jobs = [lead, ...(await claimQueued("ingest"))];
  if (jobs.length > 1) info(`[job ${short(lead.id)}] batching ${jobs.length} ingest jobs: ${jobs.slice(1).map((j) => short(j.id)).join(" ")}`);
  const heartbeat = setInterval(() => { for (const j of jobs) api(`/jobs/${j.id}/heartbeat`, { method: "POST" }).catch(() => {}); }, HEARTBEAT_MS);
  try {
    await runIngest(jobs);
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * One agent run for a batch of ingest jobs: pull once, stage every job's inputs, run the ingest skill once, commit
 * once, then answer `done` for each job (the lead job also carries the ops digest when the batch holds the
 * scheduled run). An idle scheduled run (nothing in the inbox) reports itself as skipped without starting the agent.
 */
async function runIngest(jobs: Job[]) {
  const lead = jobs[0]!;
  const tag = `[job ${short(lead.id)}${jobs.length > 1 ? ` +${jobs.length - 1}` : ""}]`;
  let bodies: Map<string, Record<string, unknown>>;
  let outcome: IngestOutcome | undefined;
  try {
    if (await hasUpstream(cfg.root)) await git(cfg.root, "pull", "--rebase", "--quiet").catch((e) => log(lead.id, `pull: ${e.message}\n`));
    for (const j of jobs) await stageInbox(j);
    const plan = planIngest(jobs.map((j) => ({ id: j.id, scheduled: !!parsePayload(j).scheduled, inbox: j.inbox ?? [] })), listInbox(cfg).map((p) => basename(p)));
    for (const j of jobs.slice(1)) await log(j.id, `bundled with job ${short(lead.id)}: ${jobs.length} ingest jobs, one agent run (log is on the lead job)\n`);
    let changes: { status: string; path: string }[] = [];
    if (plan.skip) {
      info(`${tag} inbox empty, agent skipped`);
      await log(lead.id, "inbox empty: agent skipped\n");
      outcome = { ok: true, skipped: true, commit: null };
    } else {
      const { out, code } = await runAgent(lead.id, ["ingest"]);
      await kb("validate", "--quiet").catch((e) => log(lead.id, `${e.message}\n`));
      await kb("build");
      changes = plan.scheduled ? await gitStatusPaths(cfg.root, [LAYOUT.silver]).catch(() => []) : [];
      const commit = await commitAll(ingestCommitMessage(plan));
      outcome = { ok: code === 0, summary: tail(out), commit };
      if (plan.scheduled) outcome.agentOutput = out;
    }
    // One digest per scheduled morning run, whatever the batch size: what was waiting before the agent ate it.
    if (plan.scheduled) {
      try {
        searchDb ??= openDb(cfg);
        indexNotes(cfg, searchDb);
        const digest = buildOpsDigest(cfg, { inboxNames: plan.inboxNames, agentOutput: outcome.agentOutput ?? "", agentOk: outcome.ok, changes, db: searchDb });
        outcome.digest = { text: renderOpsDigest(digest), notify: formatOpsDigest(digest) };
      } catch (e) {
        warn(`${tag} digest: ${(e as Error).message}`);
      }
    }
    bodies = ingestDoneBodies(plan, outcome);
  } catch (e) {
    bodies = ingestFailureBodies(jobs.map((j) => j.id), (e as Error).message);
  }
  for (const [id, body] of bodies) await api(`/jobs/${id}/done`, { method: "POST", body: JSON.stringify(body) });
  const first = bodies.get(lead.id)!;
  info(`${tag} ${first.ok ? (outcome?.skipped ? "skipped" : "done") : `FAILED: ${errorHead(first.result, 200)}`}`);
}

async function run(job: Job, payload: Record<string, unknown>) {
  if (job.kind !== "search" && (await hasUpstream(cfg.root))) await git(cfg.root, "pull", "--rebase", "--quiet").catch((e) => log(job.id, `pull: ${e.message}\n`));
  let body: Record<string, unknown>;
  try {
    switch (job.kind) {
      case "search": {
        // In-process (no agent CLI): LanceDB vector + Lindera BM25 on this Mac, Ollama for the query vector.
        const t0 = Date.now();
        searchDb ??= openDb(cfg);
        embedder ??= makeEmbedder(cfg);
        indexNotes(cfg, searchDb);
        const { filters } = parseFilters(String(payload.filters ?? "").split(/\s+/).filter(Boolean));
        const res = await search(cfg, searchDb, String(payload.query ?? ""), {
          mode: (payload.mode as SearchMode | undefined) ?? "hybrid", filters,
          includeArchive: !!payload.includeArchive, limit: Number(payload.limit ?? 20),
        }, { embedder });
        info(`[job ${job.id.slice(0, 8)}] search "${String(payload.query ?? "").slice(0, 40)}" -> ${res.hits.length} hits (${res.mode}${res.degraded ? ", degraded: " + res.degraded : ""}) ${Date.now() - t0}ms`);
        body = { ok: true, result: res };
        break;
      }
      case "ask": {
        const q = String(payload.question ?? "");
        const { out, code } = await runAgent(job.id, ["ask", q]);
        const { answer, sources } = parseAnswer(out);
        body = { ok: code === 0, answer, sources };
        break;
      }
      case "curate": {
        // RSS picks of the day: `kb articles curate` runs the curate skill itself (JSON in / JSON out) and prints a JSON summary.
        const { out, code } = await kbStreamed(job.id, ["articles", "curate", "--json"]);
        if (code !== 0) throw new Error(`kb articles curate failed (exit ${code}): ${tail(out, 300)}`);
        const summary = lastJson(out) as { skipped: boolean; date: string | null; path: string | null; candidates: number; picked: number; top: string[]; warnings: string[] } | null;
        if (!summary) throw new Error(`kb articles curate: no JSON summary in its output: ${tail(out, 300)}`);
        let commit: string | null = null;
        if (!summary.skipped) {
          await kb("build").catch(() => {});
          commit = await commitAll(`curate: 記事 ${summary.date} (${summary.picked}/${summary.candidates})`);
        }
        body = { ok: true, result: summary, commit };
        break;
      }
      case "recommend":
      case "skill": {
        const name = job.kind === "recommend" ? "recommend" : String(payload.name ?? "");
        const extra = payload.args ? [String(payload.args)] : [];
        if (!existsSync(join(cfg.root, ".agents", "skills", name, "SKILL.md"))) throw new Error(`no such skill ${name}`);
        const { out, code } = await runAgent(job.id, [name, ...extra]);
        await kb("build").catch(() => {});
        const commit = await commitAll(`${name}: web job`);
        body = { ok: code === 0, result: { summary: tail(out) }, commit };
        break;
      }
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
  } catch (e) {
    body = { ok: false, result: { error: (e as Error).message } };
  }
  await api(`/jobs/${job.id}/done`, { method: "POST", body: JSON.stringify(body) });
  info(`[job ${job.id.slice(0, 8)}] ${body.ok ? "done" : `FAILED: ${errorHead(body.result, 200)}`}`);
}

function tail(s: string, n = 2000) { return s.length > n ? "…" + s.slice(-n) : s; }
/** The JSON object a `--json` command printed last (its stdout may carry other lines before it). */
function lastJson(out: string): unknown {
  const i = out.lastIndexOf("\n{");
  const text = i >= 0 ? out.slice(i + 1) : out.trimStart().startsWith("{") ? out : "";
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
/** The ask skill ends with "根拠:" followed by note paths. */
function parseAnswer(out: string): { answer: string; sources: string[] } {
  const i = out.lastIndexOf("根拠:");
  if (i === -1) return { answer: out.trim(), sources: [] };
  const sources = out.slice(i).split("\n").slice(1).map((l) => l.replace(/^[-*\s]+/, "").trim()).filter((l) => l.startsWith(SILVER_PREFIX));
  return { answer: out.slice(0, i).trim(), sources };
}

/** One long-poll lane. Searches get their own lane so a minutes-long ingest/ask/skill job never makes them time out. */
async function lane(kinds: string) {
  for (;;) {
    try {
      const res = await api(`/jobs/next?wait=25&kinds=${kinds}`);
      if (res) await handle((await res.json()) as Job);
    } catch (e) {
      warn(`worker[${kinds}]: ${(e as Error).message}`);
      await Bun.sleep(5000);
    }
  }
}

info(`kb worker: api=${API} kb=${cfg.root} agent=${process.env.KB_AGENT ?? "claude"}`);
await Promise.all([lane("search"), lane("ingest,ask,recommend,skill,curate")]);
