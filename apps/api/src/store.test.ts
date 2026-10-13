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
