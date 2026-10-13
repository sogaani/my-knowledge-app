import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  runQuery, parseFilters, readNote, patchFrontmatter, createNote, DuplicateError, extractLinks,
  keywordSearch, LAYOUT, GOLD, SILVER_PREFIX, GOLD_PREFIX, type SearchResponse, type SearchMode,
} from "@kb/core";
import { env } from "./env";
import { authenticate, requireUser, requireWorker, requireInboxWriter, requireUserOrWorker, type Principal } from "./auth";
import { cfg, reg, db, sync, head, rebuildGold, commitKb, cachedLint, pushState, unsavedCount, isGitRepo } from "./kb";
import {
  createJob, getJob, listJobs, claimNextJob, appendJobLog, finishJob, requeueStale, pruneSearchJobs, waitJobEvent,
  addInboxItem, inboxItemNameExists, inboxItemsForJob, getInboxItem, markInboxFetched, addChat, listChat, newId, type JobKind,
  addPushSubscription, deletePushSubscription, listPushSubscriptions,
} from "./store";
import { pushEnabled, sendPushToAll } from "./push";

type Vars = { principal: Principal; timing: [string, number][] };
const app = new Hono<{ Variables: Vars }>();
const api = new Hono<{ Variables: Vars }>();

/** Per-request timing: a Server-Timing header (DevTools → Network → Timing) and a `[t]` log line. */
api.use("*", async (c, next) => {
  const t0 = performance.now();
  c.set("timing", []);
  await next();
  const total = performance.now() - t0;
  const parts = c.get("timing").map(([k, ms]) => `${k};dur=${ms.toFixed(1)}`);
  c.header("Server-Timing", [...parts, `app;dur=${total.toFixed(1)}`].join(", "));
  if (!c.req.path.startsWith("/api/worker/jobs/next")) {
    console.log(`[t] ${c.req.method} ${c.req.path} ${c.res.status} ${total.toFixed(0)}ms${parts.length ? ` (${c.get("timing").map(([k, ms]) => `${k}=${ms.toFixed(0)}`).join(" ")})` : ""}`);
  }
});
/** Measure one step of a request into Server-Timing. */
async function timed<T>(c: { get: (k: "timing") => [string, number][] }, name: string, f: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await f(); } finally { c.get("timing").push([name, performance.now() - t0]); }
}
api.use("*", authenticate);

const safePath = (p: string) => {
  const rel = p.replace(/^\/+/, "");
  if (rel.includes("..") || !(rel.startsWith(SILVER_PREFIX) || rel.startsWith(GOLD_PREFIX))) return null;
  return rel;
};

// ---- user routes ----
api.get("/me", (c) => c.json({ principal: c.get("principal"), kbRoot: cfg.root }));

api.get("/home", requireUser, async (c) => {
  const counts = db.query("SELECT type, COUNT(*) c FROM notes WHERE archived=0 AND path LIKE ? GROUP BY type").all(`${SILVER_PREFIX}%`) as { type: string; c: number }[];
  const subs = runQuery(db, { filters: [{ field: "type", op: "=", value: "subscription" }, { field: "status", op: "=", value: "active" }], limit: 1000 });
  const monthly = subs.reduce((a, s) => a + (s.fm.cycle === "yearly" ? Number(s.fm.price ?? 0) / 12 : Number(s.fm.price ?? 0)), 0);
  const recent = runQuery(db, { filters: [], orderBy: "-updated", limit: 12 }).filter((n) => n.path.startsWith(SILVER_PREFIX));
  const projects = runQuery(db, { filters: [{ field: "type", op: "=", value: "project" }, { field: "status", op: "=", value: "active" }], limit: 50 });
  const books = runQuery(db, { filters: [{ field: "type", op: "=", value: "book" }], limit: 5000 });
  const media = runQuery(db, { filters: [{ field: "type", op: "=", value: "media" }], limit: 5000 });
  const byStatus = (xs: typeof books) => xs.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});
  return c.json({
    counts, monthlySubscriptions: Math.round(monthly), activeSubscriptions: subs.length,
    books: byStatus(books), media: byStatus(media), projects, recent, jobs: listJobs(8),
    lint: await timed(c, "lint", cachedLint), head: head(), unpushed: unsavedCount(), pushError: pushState.error,
  });
});

api.get("/types", requireUser, (c) => c.json([...reg.types.values()].map(({ schema, ...t }) => t)));

api.get("/notes", requireUser, (c) => {
  const q = c.req.query();
  const filters = parseFilters((q.filter ?? "").split(/\s+/).filter(Boolean)).filters;
  if (q.type) filters.push({ field: "type", op: "=", value: q.type });
  if (q.status) filters.push({ field: "status", op: "=", value: q.status });
  const res = runQuery(db, { filters, text: q.text || undefined, includeArchive: q.archive === "1", limit: Number(q.limit ?? 200), orderBy: q.order || undefined });
  return c.json(res.filter((n) => n.path.startsWith(SILVER_PREFIX)));
});

/**
 * Hybrid search. Vectors + Lindera BM25 live on the Mac (LanceDB + Ollama), so non-keyword modes are run by the
 * worker as a short-lived `search` job; if it does not answer in time we fall back to the SQLite keyword search.
 */
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 8000);
api.get("/search", requireUser, async (c) => {
  const q = c.req.query();
  const query = (q.q ?? "").trim();
  const mode = (["hybrid", "vector", "keyword"].includes(q.mode ?? "") ? q.mode : "hybrid") as SearchMode;
  const filterStr = [q.filter ?? "", q.type ? `type=${q.type}` : "", q.status ? `status=${q.status}` : ""].filter(Boolean).join(" ");
  const filters = parseFilters(filterStr.split(/\s+/).filter(Boolean)).filters;
  const includeArchive = q.archive === "1";
  const limit = Math.min(Number(q.limit ?? 20), 100);
  const keyword = (degraded?: string): SearchResponse => ({ hits: keywordSearch(db, query, filters, { includeArchive, limit }), mode: "keyword", degraded });
  if (!query || mode === "keyword") return c.json(keyword());
  const job = createJob("search", { query, mode, filters: filterStr, includeArchive, limit });
  const done = await timed(c, "wait", () => waitForJob(job.id, SEARCH_TIMEOUT_MS));
  // queue = until the worker claimed it, worker = claim → done (includes the tunnel round trip of the result)
  const ms = (a?: string | null, b?: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  const queuedMs = ms(done?.created_at, done?.started_at), workerMs = ms(done?.started_at, done?.finished_at);
  if (queuedMs !== null) c.get("timing").push(["queue", queuedMs]);
  if (workerMs !== null) c.get("timing").push(["worker", workerMs]);
  if (done?.status === "done" && done.result) {
    const r = JSON.parse(done.result) as SearchResponse;
    if (Array.isArray(r.hits)) return c.json({ ...r, job: job.id, queuedMs, workerMs });
  }
  return c.json({ ...keyword(done?.status === "failed" ? `worker: ${String(done.result ?? "failed").slice(0, 200)}` : "worker-timeout"), job: job.id, queuedMs, workerMs });
});
/** Wait until the job is done/failed or the timeout passes; woken by finishJob, not by polling. */
async function waitForJob(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = getJob(id);
    if (!j || j.status === "done" || j.status === "failed" || Date.now() >= deadline) return j;
    await waitJobEvent(`done:${id}`, deadline - Date.now());
  }
}

/** The note page payload (GET, and the answer to PATCH so the page needs no reload). */
function noteDetail(rel: string) {
  const abs = join(cfg.root, rel);
  const note = readNote(cfg, abs);
  if (!note) return null;
  const backlinks = (db.query("SELECT src FROM links WHERE dst=?").all(rel) as { src: string }[]).map((r) => r.src);
  const attachments: Record<string, string> = {};
  if (rel.endsWith("/README.md")) {
    for (const f of ["log.md", "tasks.md"]) {
      const p = join(abs, "..", f);
      if (existsSync(p)) attachments[f] = readFileSync(p, "utf8");
    }
  }
  return { path: note.path, type: note.type, title: note.title, fm: note.fm, body: note.body, archived: note.archived, links: extractLinks(note), backlinks, attachments };
}
api.get("/notes/*", requireUser, (c) => {
  const rel = safePath(c.req.path.replace(/^\/api\/notes\//, ""));
  if (!rel) return c.json({ error: "bad path" }, 400);
  if (!existsSync(join(cfg.root, rel))) return c.json({ error: "not found" }, 404);
  const d = noteDetail(rel);
  if (d) return c.json(d);
  // log.md / tasks.md of a folder entity have no frontmatter: answer with the entity, which shows them as attachments
  const readme = rel.replace(/[^/]+$/, "README.md");
  const parent = readme !== rel && existsSync(join(cfg.root, readme)) ? noteDetail(readme) : null;
  const name = basename(rel);
  if (parent && name in parent.attachments) return c.json({ ...parent, attachment: name });
  return c.json({ error: "not a note" }, 400);
});

api.patch("/notes/*", requireUser, async (c) => {
  const rel = safePath(c.req.path.replace(/^\/api\/notes\//, ""));
  if (!rel || !rel.startsWith(SILVER_PREFIX)) return c.json({ error: "bad path" }, 400);
  const abs = join(cfg.root, rel);
  if (!existsSync(abs)) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json()) as { fm?: Record<string, unknown>; append?: { section: string; line: string } };
  const before = readFileSync(abs, "utf8");
  // Only reject problems this request introduces: a note that already fails validation (e.g. a field hand-edited
  // in git) must still accept an appended history line or an unrelated field change.
  const errorsBefore = new Set(reg.validate(readNote(cfg, abs)?.fm ?? {}));
  const fm = patchFrontmatter(abs, body.fm ?? {});
  if (body.append) {
    const { appendToSection } = await import("@kb/core");
    appendToSection(abs, body.append.section, body.append.line);
  }
  const errors = reg.validate(fm).filter((e) => !errorsBefore.has(e));
  if (errors.length) { writeFileSync(abs, before); return c.json({ error: "invalid", errors }, 422); }
  const p = c.get("principal");
  const commit = await timed(c, "index", () => commitKb([rel], `web: update ${rel}\n\nby ${p.kind === "user" ? p.email : p.name}`));
  return c.json({ ...noteDetail(rel), fm, commit });
});

api.post("/notes", requireUser, async (c) => {
  const body = (await c.req.json()) as { type: string; title: string; set?: Record<string, unknown>; force?: boolean };
  try {
    const rel = createNote(cfg, reg, db, { type: body.type, title: body.title, set: body.set, force: body.force });
    const commit = await timed(c, "index", () => commitKb([rel.replace(/\/README\.md$/, "")], `web: new ${body.type} ${body.title}`));
    return c.json({ path: rel, commit });
  } catch (e) {
    if (e instanceof DuplicateError) return c.json({ error: "duplicate", matches: e.matches }, 409);
    return c.json({ error: String(e) }, 400);
  }
});

/** Gold pages are generated Markdown without frontmatter (so /notes/* does not serve them). Subfolders ok: 304_books/index. */
api.get("/gold/*", requireUser, (c) => {
  const name = decodeURIComponent(c.req.path.replace(/^\/api\/gold\//, "")).replace(/\.md$/, "");
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.split("/").some((s) => s === "." || s === "..")) return c.json({ error: "bad path" }, 400);
  const abs = join(cfg.gold, `${name}.md`);
  if (!existsSync(abs)) return c.json({ error: "not found" }, 404);
  return c.json({ name, markdown: readFileSync(abs, "utf8") });
});

/** Suggestions live in 300_gold/307_suggestions.md as checklist lines with <!-- id: x --> markers. */
// ---- Web Push: the browser subscribes here; the worker's job completion fans out (see /worker/jobs/:id/done) ----
api.get("/push/vapid", requireUser, (c) => c.json({ publicKey: pushEnabled() ? env.vapidPublicKey : null, subscriptions: listPushSubscriptions().length }));
api.post("/push/subscribe", requireUser, async (c) => {
  const sub = (await c.req.json()) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys.auth) return c.json({ error: "invalid subscription" }, 400);
  const p = c.get("principal"); addPushSubscription(sub as { endpoint: string }, p.kind === "user" ? p.email : null, c.req.header("user-agent") ?? null);
  return c.json({ ok: true });
});
api.delete("/push/subscribe", requireUser, async (c) => {
  const { endpoint } = (await c.req.json()) as { endpoint?: string };
  if (endpoint) deletePushSubscription(endpoint);
  return c.json({ ok: true });
});
api.post("/push/test", requireUser, async (c) => c.json(await sendPushToAll({ title: "my-knowledge", body: "テスト通知です", url: "/trading", tag: "test" })));

api.post("/suggestions/react", requireUser, async (c) => {
  const { id, reaction, title, type } = (await c.req.json()) as { id: string; reaction: "read" | "dismissed"; title?: string; type?: "book" | "media" };
  const abs = join(cfg.gold, GOLD.suggestions);
  if (!existsSync(abs)) return c.json({ error: "no suggestions" }, 404);
  const text = readFileSync(abs, "utf8");
  if (!id) return c.json({ error: "id required" }, 400);
  const re = new RegExp(`<!--\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*-->`);
  if (!re.test(text)) return c.json({ error: "id not found" }, 404);
  writeFileSync(abs, text.replace(re, `<!-- id: ${id}, reaction: ${reaction} -->`).replace(new RegExp(`- \\[ \\]([^\\n]*<!-- id: ${id},)`), "- [x]$1"));
  const paths = [`${GOLD_PREFIX}${GOLD.suggestions}`];
  let created: string | null = null;
  if (reaction === "read" && title && type) {
    try { created = createNote(cfg, reg, db, { type, title, set: { status: "want", summary: "おすすめから追加" } }); paths.push(created); } catch {}
  }
  const commit = await timed(c, "index", () => commitKb(paths, `web: suggestion ${id} ${reaction}`));
  return c.json({ ok: true, created, commit });
});

/** Uploaded filenames come from outside (web UI, Apps Script): keep the basename, drop path/control chars. */
const safeName = (n: string, id: string) => {
  const b = basename(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 150);
  return b || `file-${id.slice(0, 8)}`;
};
api.post("/inbox", requireInboxWriter, async (c) => {
  const ct = c.req.header("content-type") ?? "";
  const jobId = newId();
  const items: { id: string; kind: "url" | "text" | "file"; name: string }[] = [];
  const skipped: string[] = [];
  const stage = join(env.dataDir, "staging", jobId);
  mkdirSync(stage, { recursive: true });
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    for (const [k, raw] of form.entries()) {
      const v = raw as unknown as string | File;
      if (typeof v !== "string") {
        const id = newId();
        let name = safeName(v.name, id);
        if (inboxItemNameExists(name)) { skipped.push(name); continue; }
        if (existsSync(join(stage, name))) name = `${id.slice(0, 8)}-${name}`;
        const p = join(stage, name);
        writeFileSync(p, new Uint8Array(await v.arrayBuffer()));
        addInboxItem({ id, job_id: jobId, kind: "file", name, path: p, url: null, text: null });
        items.push({ id, kind: "file", name });
      } else if (k === "url" && String(v).trim()) {
        const id = newId(); addInboxItem({ id, job_id: jobId, kind: "url", name: String(v), path: null, url: String(v).trim(), text: null }); items.push({ id, kind: "url", name: String(v) });
      } else if (k === "text" && String(v).trim()) {
        const id = newId(); const name = `memo-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 6)}.md`;
        addInboxItem({ id, job_id: jobId, kind: "text", name, path: null, url: null, text: String(v) }); items.push({ id, kind: "text", name });
      }
    }
  } else {
    const b = (await c.req.json()) as { url?: string; text?: string; title?: string };
    if (b.url) { const id = newId(); addInboxItem({ id, job_id: jobId, kind: "url", name: b.url, path: null, url: b.url, text: null }); items.push({ id, kind: "url", name: b.url }); }
    if (b.text) { const id = newId(); const name = `${(b.title ?? "memo").replace(/[\\/:*?"<>|]/g, "")}-${id.slice(0, 6)}.md`; addInboxItem({ id, job_id: jobId, kind: "text", name, path: null, url: null, text: b.text }); items.push({ id, kind: "text", name }); }
  }
  const who = c.get("principal");
  console.log(`inbox: ${who.kind}/${who.kind === "user" ? who.email : who.name} staged ${items.length} skipped ${skipped.length}`);
  // Everything already staged earlier: still 200 so an idempotent pusher can mark its side as done.
  if (!items.length) return skipped.length ? c.json({ job: null, items, skipped }) : c.json({ error: "nothing to ingest" }, 400);
  const job = createJob("ingest", { items }, jobId);
  return c.json({ job, items, skipped });
});

api.get("/jobs", requireUser, (c) => c.json(listJobs(Number(c.req.query("limit") ?? 50))));
api.get("/jobs/:id", requireUser, (c) => { const j = getJob(c.req.param("id") ?? ""); return j ? c.json(j) : c.json({ error: "not found" }, 404); });
api.post("/jobs", requireUserOrWorker, async (c) => {
  const b = (await c.req.json()) as { kind: JobKind; payload?: unknown };
  if (!["ingest", "ask", "recommend", "skill"].includes(b.kind)) return c.json({ error: "bad kind" }, 400);
  return c.json(createJob(b.kind, b.payload ?? {}));
});

api.get("/chat", requireUser, (c) => c.json(listChat()));
api.post("/chat", requireUser, async (c) => {
  const { question } = (await c.req.json()) as { question: string };
  if (!question?.trim()) return c.json({ error: "empty" }, 400);
  const job = createJob("ask", { question });
  const msg = addChat("user", question, job.id);
  return c.json({ message: msg, job });
});

api.post("/sync", requireUser, async (c) => c.json(await sync("manual")));
api.post("/build", requireUser, async (c) => {
  const files = await timed(c, "build", rebuildGold);
  const commit = await timed(c, "index", () => commitKb([LAYOUT.gold], "web: kb build"));
  return c.json({ files, commit });
});

// ---- worker routes ----
const w = new Hono<{ Variables: Vars }>();
w.use("*", requireWorker);
/** Long-poll for the next job. `kinds=search` lets the worker run searches in their own lane, beside long agent jobs. */
w.get("/jobs/next", async (c) => {
  const wait = Math.min(Number(c.req.query("wait") ?? 25), 55);
  const kinds = (c.req.query("kinds") ?? "").split(",").filter(Boolean);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const j = claimNextJob(kinds);
    if (j) return c.json({ ...j, inbox: j.kind === "ingest" ? inboxItemsForJob(j.id).map(({ path, ...i }) => i) : [] });
    if (Date.now() >= deadline) return c.body(null, 204);
    await waitJobEvent("queued", deadline - Date.now());
  }
});
w.get("/inbox/:id", (c) => {
  const it = getInboxItem(c.req.param("id") ?? "");
  if (!it) return c.json({ error: "not found" }, 404);
  markInboxFetched(it.id);
  if (it.kind === "file" && it.path) return new Response(Bun.file(it.path), { headers: { "content-disposition": `attachment; filename="${encodeURIComponent(it.name)}"` } });
  if (it.kind === "text") return c.text(it.text ?? "");
  return c.json({ url: it.url });
});
w.post("/jobs/:id/log", async (c) => { appendJobLog(c.req.param("id") ?? "", await c.req.text()); return c.json({ ok: true }); });
w.post("/jobs/:id/done", async (c) => {
  const id = c.req.param("id") ?? "";
  const b = (await c.req.json()) as { ok: boolean; result?: unknown; commit?: string | null; answer?: string; sources?: string[] };
  finishJob(id, b.ok, b.result ?? b.answer ?? null, b.commit);
  const job = getJob(id);
  if (job?.kind === "ask") addChat("assistant", b.ok ? (b.answer ?? "") : `失敗: ${JSON.stringify(b.result)}`, id, b.sources ?? []);
  if (b.commit) await sync(`job:${id}`);
  else if (b.ok && job?.kind !== "ask" && job?.kind !== "search") await sync(`job:${id}`);
  if (b.ok && job) notifyJobDone(job.kind, JSON.parse(job.payload) as Record<string, unknown>).catch((e) => console.error("push:", e));
  return c.json({ ok: true });
});
/** Push notifications for jobs people wait for. trade-plan: only when today's (JST) sheet exists, so a 休場 run stays silent. */
async function notifyJobDone(kind: string, payload: Record<string, unknown>) {
  if (!pushEnabled()) return;
  if (kind === "skill" && payload.name === "trade-plan") {
    const jst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const wanted = /date=(\d{4}-\d{2}-\d{2})/.exec(String(payload.args ?? ""))?.[1] ?? jst;
    const plan = runQuery(db, { filters: [{ field: "type", op: "=", value: "trade_plan" }, { field: "date", op: "=", value: wanted }], limit: 1 })[0];
    if (!plan) return;
    const orders = Array.isArray(plan.fm.orders) ? (plan.fm.orders as { side?: string }[]) : [];
    const acts = orders.filter((o) => o.side && o.side !== "hold").length;
    const r = await sendPushToAll({ title: `本日の売買シート ${wanted}`, body: `${plan.summary || plan.title}${acts ? ` · 注文 ${acts} 件` : " · 注文なし"}`, url: "/trading", tag: "trade-plan" });
    console.log(`push trade-plan ${wanted}: sent ${r.sent}, removed ${r.removed}, failed ${r.failed}`);
  }
}
api.route("/worker", w);

app.route("/api", api);
app.get("/healthz", (c) => c.text("ok"));
if (existsSync(env.webDist)) {
  app.use("/*", serveStatic({ root: env.webDist.replace(/^\.\//, ""), rewriteRequestPath: (p) => p }));
  app.get("*", (c) => c.html(readFileSync(join(env.webDist, "index.html"), "utf8")));
}

// ---- startup ----
await sync("startup");
setInterval(() => { requeueStale(); pruneSearchJobs(); sync("interval"); }, env.syncIntervalSec * 1000);
console.log(`kb api on :${env.port} (kb=${cfg.root}, git=${isGitRepo}, auth=${env.devBypassAuth ? "DEV BYPASS" : "cloudflare access"})`);
export default { port: env.port, fetch: app.fetch, idleTimeout: 60 };
