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
