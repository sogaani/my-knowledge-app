#!/usr/bin/env bun
/**
 * Mac-side agent worker: long-polls the API for jobs and runs them against the local KB checkout
 * with the agent CLI chosen by KB_AGENT (claude|codex|gemini). Never exposes a port.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT, SILVER_PREFIX, loadConfig, git, gitCommitPush, openDb, indexNotes, parseFilters, search, makeEmbedder, type SearchMode } from "@kb/core";

const API = (process.env.KB_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const cfg = loadConfig(process.env.KB_ROOT);
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.WORKER_TOKEN) headers.authorization = `Bearer ${process.env.WORKER_TOKEN}`;
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
}
import { hasUpstream } from "@kb/core";

interface Job { id: string; kind: string; payload: string; inbox?: { id: string; kind: "url" | "text" | "file"; name: string }[] }

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/api/worker${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
}
const log = (id: string, text: string) => api(`/jobs/${id}/log`, { method: "POST", body: text, headers: { "content-type": "text/plain" } }).catch(() => {});

/** Run run-agent.sh and stream its output to the job log. Returns full stdout. */
async function runAgent(jobId: string, args: string[]): Promise<{ out: string; code: number }> {
  const script = join(cfg.root, LAYOUT.system, "scripts", "run-agent.sh");
  const proc = Bun.spawn(["bash", script, ...args], { cwd: cfg.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, KB_ROOT: cfg.root } });
  let out = "", buf = "";
  const flush = setInterval(() => { if (buf) { log(jobId, buf); buf = ""; } }, 2000);
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s) { const t = new TextDecoder().decode(chunk); out += t; buf += t; } };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
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

async function commitAll(message: string): Promise<string | null> {
  return gitCommitPush(cfg.root, [LAYOUT.silver, LAYOUT.gold], message, { author: "kb-worker <kb-worker@local>" });
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

async function handle(job: Job) {
  const payload = JSON.parse(job.payload || "{}") as Record<string, unknown>;
  console.log(`[job ${job.id.slice(0, 8)}] ${job.kind}`);
  if (job.kind !== "search" && (await hasUpstream(cfg.root))) await git(cfg.root, "pull", "--rebase", "--quiet").catch((e) => log(job.id, `pull: ${e.message}\n`));
  let body: Record<string, unknown>;
  try {
    switch (job.kind) {
      case "search": {
        // In-process (no agent CLI): LanceDB vector + Lindera BM25 on this Mac, Ollama for the query vector.
        const t0 = Date.now();
        const db = openDb(cfg);
        indexNotes(cfg, db);
        const { filters } = parseFilters(String(payload.filters ?? "").split(/\s+/).filter(Boolean));
        const res = await search(cfg, db, String(payload.query ?? ""), {
          mode: (payload.mode as SearchMode | undefined) ?? "hybrid", filters,
          includeArchive: !!payload.includeArchive, limit: Number(payload.limit ?? 20),
        }, { embedder: makeEmbedder(cfg) });
        db.close();
        console.log(`[job ${job.id.slice(0, 8)}] search "${String(payload.query ?? "").slice(0, 40)}" -> ${res.hits.length} hits (${res.mode}${res.degraded ? ", degraded: " + res.degraded : ""}) ${Date.now() - t0}ms`);
        body = { ok: true, result: res };
        break;
      }
      case "ingest": {
        await stageInbox(job);
        const { out, code } = await runAgent(job.id, ["ingest"]);
        await kb("validate", "--quiet").catch((e) => log(job.id, `${e.message}\n`));
        await kb("build");
        const commit = await commitAll(`ingest: ${(job.inbox ?? []).map((i) => i.name).join(", ") || "inbox"}`);
        body = { ok: code === 0, result: { summary: tail(out) }, commit };
        break;
      }
      case "ask": {
        const q = String(payload.question ?? "");
        const { out, code } = await runAgent(job.id, ["ask", q]);
        const { answer, sources } = parseAnswer(out);
        body = { ok: code === 0, answer, sources };
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
  console.log(`[job ${job.id.slice(0, 8)}] ${body.ok ? "done" : "FAILED"}`);
}

function tail(s: string, n = 2000) { return s.length > n ? "…" + s.slice(-n) : s; }
/** The ask skill ends with "根拠:" followed by note paths. */
function parseAnswer(out: string): { answer: string; sources: string[] } {
  const i = out.lastIndexOf("根拠:");
  if (i === -1) return { answer: out.trim(), sources: [] };
  const sources = out.slice(i).split("\n").slice(1).map((l) => l.replace(/^[-*\s]+/, "").trim()).filter((l) => l.startsWith(SILVER_PREFIX));
  return { answer: out.slice(0, i).trim(), sources };
}

console.log(`kb worker: api=${API} kb=${cfg.root} agent=${process.env.KB_AGENT ?? "claude"}`);
for (;;) {
  try {
    const res = await api("/jobs/next?wait=25");
    if (res) await handle((await res.json()) as Job);
  } catch (e) {
    console.error("worker:", (e as Error).message);
    await Bun.sleep(5000);
  }
}
