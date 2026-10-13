import { describe, expect, test } from "bun:test";
import { SKIP_SUMMARY, ingestCommitMessage, ingestDoneBodies, ingestFailureBodies, planIngest, type BatchJob } from "./ingest-batch";

const sched = (id: string): BatchJob => ({ id, scheduled: true, inbox: [] });
const web = (id: string, ...names: string[]): BatchJob => ({ id, scheduled: false, inbox: names.map((name) => ({ name })) });

describe("planIngest", () => {
  test("collects every job's inputs, keeps the lead first and flags the batch as scheduled when any job is", () => {
    const plan = planIngest([web("a", "memo-1.md"), sched("b"), web("c", "paper.pdf", "https://example.com/x")], ["memo-1.md", "paper.pdf", "url-c.md", "collect-github-x.json"]);
    expect(plan.ids).toEqual(["a", "b", "c"]);
    expect(plan.scheduled).toBe(true);
    expect(plan.skip).toBe(false);
    expect(plan.inputs).toEqual(["memo-1.md", "paper.pdf", "https://example.com/x"]);
    expect(plan.inboxNames).toHaveLength(4);
  });

  test("an idle scheduled run (empty inbox, no inputs) is skipped", () => {
    expect(planIngest([sched("a")], []).skip).toBe(true);
    expect(planIngest([sched("a"), sched("b")], []).skip).toBe(true);
  });

  test("a scheduled run with collector output in the inbox runs the agent", () => {
    const plan = planIngest([sched("a")], ["collect-gmail-2026-10-13_2026-10-14.json"]);
    expect(plan.skip).toBe(false);
    expect(plan.scheduled).toBe(true);
  });

  test("a WebUI job is never skipped, even on an empty inbox, alone or batched with the scheduled run", () => {
    expect(planIngest([web("a")], []).skip).toBe(false);
    expect(planIngest([sched("a"), web("b")], []).skip).toBe(false);
    expect(planIngest([sched("a"), web("b")], []).scheduled).toBe(true);
    expect(planIngest([web("a", "x.md")], []).skip).toBe(false);
  });

  test("a WebUI-only batch does not build a digest", () => {
    expect(planIngest([web("a", "x.md"), web("b", "y.md")], ["x.md", "y.md"]).scheduled).toBe(false);
  });
});

describe("ingestCommitMessage", () => {
  test("lists the staged inputs, or `inbox` when the jobs brought none", () => {
    expect(ingestCommitMessage(planIngest([web("a", "x.md"), web("b", "y.pdf")], ["x.md", "y.pdf"]))).toBe("ingest: x.md, y.pdf");
    expect(ingestCommitMessage(planIngest([sched("a")], ["collect-github-x.json"]))).toBe("ingest: inbox");
  });
});

describe("ingestDoneBodies", () => {
  const digest = { text: "# 運用ダイジェスト 2026-10-14\n…", notify: { title: "運用ダイジェスト 10/14", body: "収集: …" } };

  test("every job gets the shared outcome and the batch ids; only the lead carries the push", () => {
    const plan = planIngest([web("a", "x.md"), sched("b"), web("c", "y.md")], ["x.md", "y.md"]);
    const bodies = ingestDoneBodies(plan, { ok: true, summary: "took 2 notes", commit: "abc123", digest });
    expect([...bodies.keys()]).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      const b = bodies.get(id)!;
      expect(b.ok).toBe(true);
      expect(b.commit).toBe("abc123");
      expect(b.result).toEqual({ summary: "took 2 notes", batch: ["a", "b", "c"], digest: digest.text });
    }
    expect(bodies.get("a")!.notify).toEqual(digest.notify);
    expect(bodies.get("b")!.notify).toBeUndefined();
    expect(bodies.get("c")!.notify).toBeUndefined();
  });

  test("a single job has no batch field and no notify without a digest", () => {
    const bodies = ingestDoneBodies(planIngest([web("a", "x.md")], ["x.md"]), { ok: false, summary: "boom", commit: null });
    expect(bodies.get("a")).toEqual({ ok: false, result: { summary: "boom" }, commit: null });
  });

  test("a skipped run is ok, says so, carries no commit and still sends the digest", () => {
    const bodies = ingestDoneBodies(planIngest([sched("a")], []), { ok: true, skipped: true, commit: null, digest });
    const b = bodies.get("a")!;
    expect(b.ok).toBe(true);
    expect(b.commit).toBeNull();
    expect(b.result).toEqual({ summary: SKIP_SUMMARY, skipped: true, digest: digest.text });
    expect(b.notify).toEqual(digest.notify);
  });
});

describe("ingestFailureBodies", () => {
  test("the same error on every job, with the batch ids when there are several", () => {
    const bodies = ingestFailureBodies(["a", "b"], "kb build: exit 1");
    expect(bodies.get("a")).toEqual({ ok: false, result: { error: "kb build: exit 1", batch: ["a", "b"] } });
    expect(bodies.get("b")!.result).toEqual({ error: "kb build: exit 1", batch: ["a", "b"] });
    expect(ingestFailureBodies(["a"], "x").get("a")).toEqual({ ok: false, result: { error: "x" } });
  });
});
