import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// store.ts opens jobs.sqlite under DATA_DIR at import time: point it at a scratch dir first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "kb-store-"));
let s: typeof import("./store");
beforeAll(async () => { s = await import("./store"); });

const MIN = 60_000;
const backdate = (id: string, col: "started_at" | "heartbeat_at", minutesAgo: number) =>
  s.store.run(`UPDATE jobs SET ${col}=? WHERE id=?`, [new Date(Date.now() - minutesAgo * MIN).toISOString(), id]);

describe("requeueStale", () => {
  test("measures silence from the last heartbeat / log line, not from the start", () => {
    const job = s.createJob("skill", { name: "long" });
    expect(s.claimNextJob(["skill"])?.id).toBe(job.id);
    expect(s.getJob(job.id)?.heartbeat_at).toBeTruthy();
    // started an hour ago but still reporting: stays running
    backdate(job.id, "started_at", 60);
    backdate(job.id, "heartbeat_at", 2);
    expect(s.requeueStale(15)).toBe(0);
    expect(s.getJob(job.id)?.status).toBe("running");
    // a log line refreshes the heartbeat
    backdate(job.id, "heartbeat_at", 20);
    s.appendJobLog(job.id, "still here\n");
    expect(s.requeueStale(15)).toBe(0);
    // explicit heartbeat too
    backdate(job.id, "heartbeat_at", 20);
    s.touchJob(job.id);
    expect(s.requeueStale(15)).toBe(0);
    // silent for 20 minutes: requeued, heartbeat cleared
    backdate(job.id, "heartbeat_at", 20);
    expect(s.requeueStale(15)).toBe(1);
    const j = s.getJob(job.id)!;
    expect(j.status).toBe("queued");
    expect(j.started_at).toBeNull();
    expect(j.heartbeat_at).toBeNull();
    s.finishJob(job.id, true, null);
  });

  test("a job claimed without any heartbeat (older worker) falls back to its start time", () => {
    const job = s.createJob("ingest", {});
    s.claimNextJob(["ingest"]);
    s.store.run("UPDATE jobs SET heartbeat_at=NULL WHERE id=?", [job.id]);
    backdate(job.id, "started_at", 10);
    expect(s.requeueStale(15)).toBe(0);
    backdate(job.id, "started_at", 16);
    expect(s.requeueStale(15)).toBe(1);
    s.finishJob(job.id, false, { error: "x" });
  });

  test("touchJob ignores jobs that are not running", () => {
    const job = s.createJob("ask", { question: "q" });
    s.touchJob(job.id);
    expect(s.getJob(job.id)?.heartbeat_at).toBeNull();
    s.finishJob(job.id, true, null);
  });
});

describe("claimQueuedJobs", () => {
  test("claims every queued job of the kind at once, oldest first, and leaves other kinds and running jobs alone", () => {
    const a = s.createJob("ingest", { items: [] });
    const other = s.createJob("skill", { name: "x" });
    const b = s.createJob("ingest", { scheduled: true });
    const c = s.createJob("ingest", { items: [] });
    // the lead claim the worker gets from /jobs/next
    expect(s.claimNextJob(["ingest"])?.id).toBe(a.id);
    const rest = s.claimQueuedJobs("ingest");
    expect(rest.map((j) => j.id)).toEqual([b.id, c.id]);
    for (const j of rest) {
      expect(j.status).toBe("running");
      expect(j.started_at).toBeTruthy();
      expect(j.heartbeat_at).toBeTruthy();
    }
    expect(s.getJob(other.id)?.status).toBe("queued");
    // nothing left to claim: empty, and the lead was not re-claimed
    expect(s.claimQueuedJobs("ingest")).toEqual([]);
    expect(s.claimNextJob(["ingest"])).toBeNull();
    expect(s.claimNextJob(["skill"])?.id).toBe(other.id);
    for (const id of [a.id, b.id, c.id, other.id]) s.finishJob(id, true, null);
  });

  test("respects the limit", () => {
    const ids = [1, 2, 3].map(() => s.createJob("ingest", {}).id);
    expect(s.claimQueuedJobs("ingest", 2).map((j) => j.id)).toEqual(ids.slice(0, 2));
    expect(s.claimQueuedJobs("ingest").map((j) => j.id)).toEqual(ids.slice(2));
    for (const id of ids) s.finishJob(id, true, null);
  });
});

describe("waitJobEvent", () => {
  test("wakes when the job finishes, and on its own after the timeout", async () => {
    const job = s.createJob("ask", { question: "q" });
    const t0 = Date.now();
    const woke = s.waitJobEvent(`done:${job.id}`, 5000).then(() => Date.now() - t0);
    s.finishJob(job.id, true, null);
    expect(await woke).toBeLessThan(1000);
    const t1 = Date.now();
    await s.waitJobEvent("done:never", 30);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(25);
    // a job queued wakes the worker's long-poll
    const queued = s.waitJobEvent("queued", 5000);
    const other = s.createJob("ingest", {});
    await queued;
    s.finishJob(other.id, true, null);
  });
});

describe("views", () => {
  test("records each page view and answers the last one per path", () => {
    const a = "200_silver/204_books/a.md", b = "200_silver/204_books/b.md";
    expect(s.lastViewed([a, b]).size).toBe(0);
    expect(s.viewCount(a)).toBe(0);
    s.recordView(a);
    s.store.run("UPDATE views SET viewed_at=? WHERE path=?", ["2026-10-01T00:00:00.000Z", a]);
    s.recordView(a);
    s.recordView(b);
    const seen = s.lastViewed([a, b, "200_silver/204_books/never.md"]);
    expect(seen.size).toBe(2);
    expect(seen.get(a)! > "2026-10-01T00:00:00.000Z").toBe(true);
    expect(seen.get(b)).toBeTruthy();
    expect(s.viewCount(a)).toBe(2);
    expect(s.lastViewed([]).size).toBe(0);
  });
});

describe("listExchanges", () => {
  const backdateChat = (id: string, minutesAgo: number) =>
    s.store.run("UPDATE chat_messages SET created_at=? WHERE id=?", [new Date(Date.now() - minutesAgo * MIN).toISOString(), id]);
  test("pairs each question with its answer by job id, newest first, and pages back with `before`", () => {
    s.store.run("DELETE FROM chat_messages");
    const j1 = s.createJob("ask", { question: "q1" }), j2 = s.createJob("ask", { question: "q2" }), j3 = s.createJob("ask", { question: "q3" });
    const q1 = s.addChat("user", "q1", j1.id); backdateChat(q1.id, 30);
    const a1 = s.addChat("assistant", "a1", j1.id, ["200_silver/204_books/x.md"]); backdateChat(a1.id, 29);
    const q2 = s.addChat("user", "q2", j2.id); backdateChat(q2.id, 20);
    const a2 = s.addChat("assistant", "a2", j2.id); backdateChat(a2.id, 19);
    const q3 = s.addChat("user", "q3", j3.id); backdateChat(q3.id, 10); // still being answered
    const legacy = s.addChat("user", "old", null); backdateChat(legacy.id, 40); // a row from before job ids were kept

    const first = s.listExchanges(1);
    expect(first).toHaveLength(1);
    expect(first[0]!.question.text).toBe("q3");
    expect(first[0]!.answer).toBeNull();
    expect(first[0]!.created_at).toBe(first[0]!.question.created_at);

    const rest = s.listExchanges(2, first[0]!.created_at);
    expect(rest.map((x) => x.question.text)).toEqual(["q2", "q1"]);
    expect(rest[0]!.answer?.text).toBe("a2");
    expect(rest[1]!.answer?.text).toBe("a1");
    expect(rest[1]!.answer?.sources).toBe(JSON.stringify(["200_silver/204_books/x.md"]));

    const tail = s.listExchanges(10, rest[1]!.created_at);
    expect(tail.map((x) => x.question.text)).toEqual(["old"]);
    expect(tail[0]!.job_id).toBeNull();
    expect(tail[0]!.answer).toBeNull();
    // answers never show up as exchanges of their own
    expect(s.listExchanges(50).map((x) => x.question.role)).toEqual(["user", "user", "user", "user"]);
  });
  test("keeps the first answer when a job somehow answered twice", () => {
    s.store.run("DELETE FROM chat_messages");
    const j = s.createJob("ask", { question: "q" });
    s.addChat("user", "q", j.id);
    const a = s.addChat("assistant", "first", j.id);
    const b = s.addChat("assistant", "second", j.id);
    backdateChat(a.id, 2); backdateChat(b.id, 1);
    expect(s.listExchanges(1)[0]!.answer?.text).toBe("first");
  });
});

describe("captures", () => {
  const add = (key: string, version: number, hash: string) => {
    const job = s.createJob("ingest", { items: [] });
    const id = s.newId();
    s.addCapture({ id, key, version, hash, client: "chrome", platform: "gemini", title: "t", url: null, area: null, job_id: job.id, item_name: `capture-${id}.md`, input: "{}" });
    return { id, job };
  };
  test("settle from the worker's per-item outcomes", () => {
    const a = add("gemini:1", 1, "h1");
    s.settleCaptures(a.job.id, true, [{ name: `capture-${a.id}.md`, bronze: "20261103-note-aaaaaa", notes: ["200_silver/201_learning/x.md"], processed: true }]);
    expect(s.getCaptureRow(a.id)).toMatchObject({ status: "done", bronze: "20261103-note-aaaaaa", notes: '["200_silver/201_learning/x.md"]' });
    expect(s.lastCaptureNotes("gemini:1")).toEqual(["200_silver/201_learning/x.md"]);
    const b = add("gemini:1", 2, "h2");
    expect(s.latestCapture("gemini:1")?.id).toBe(b.id);
    // in Bronze but not processed → stored; previous notes stay those of v1
    s.settleCaptures(b.job.id, true, [{ name: `capture-${b.id}.md`, bronze: "20261103-note-bbbbbb", notes: [], processed: false }]);
    expect(s.getCaptureRow(b.id)?.status).toBe("stored");
    expect(s.lastCaptureNotes("gemini:1")).toEqual(["200_silver/201_learning/x.md"]);
  });
  test("a failed job, or an item left in the inbox, fails the capture", () => {
    const a = add("claude:2", 1, "h");
    s.settleCaptures(a.job.id, false, null, "boom");
    expect(s.getCaptureRow(a.id)).toMatchObject({ status: "failed", error: "boom" });
    const b = add("claude:3", 1, "h");
    s.settleCaptures(b.job.id, true, []);
    expect(s.getCaptureRow(b.id)?.status).toBe("failed");
    // settled rows are not touched again
    s.settleCaptures(b.job.id, true, [{ name: `capture-${b.id}.md`, bronze: "x", notes: [], processed: true }]);
    expect(s.getCaptureRow(b.id)?.status).toBe("failed");
  });
  test("a version still waiting for the worker is replaced in place; a claimed one is not", () => {
    const a = add("chatgpt:9", 1, "h1");
    s.addInboxItem({ id: s.newId(), job_id: a.job.id, kind: "text", name: `capture-${a.id}.md`, path: null, url: null, text: "old" });
    expect(s.replaceQueuedCapture(a.id, { hash: "h2", title: "t2", url: null, area: "work", input: '{"x":1}', text: "new" })).toBe(true);
    expect(s.getCaptureRow(a.id)).toMatchObject({ hash: "h2", title: "t2", area: "work", version: 1, input: '{"x":1}' });
    expect(s.inboxItemsForJob(a.job.id)[0]?.text).toBe("new");
    expect(s.captureForItem(a.job.id, `capture-${a.id}.md`)?.id).toBe(a.id);
    // the worker claimed the job: no more in-place replacement
    s.claimQueuedJobs("ingest");
    expect(s.replaceQueuedCapture(a.id, { hash: "h3", title: "t3", url: null, area: null, input: "{}", text: "newer" })).toBe(false);
    expect(s.getCaptureRow(a.id)?.hash).toBe("h2");
  });
});
