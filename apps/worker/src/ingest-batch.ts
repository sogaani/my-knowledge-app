/**
 * Batched ingest: the pure decisions behind running several queued ingest jobs through one agent run.
 *
 * When the worker claims an ingest job it also claims every other queued ingest job, stages all their inputs into
 * 000_inbox, and runs the agent once (one model call, one pull/rebase, one commit). The scheduled morning run skips
 * the agent altogether when there is nothing in the inbox. Kept free of I/O so it can be tested on its own.
 */

export interface BatchJob {
  id: string;
  /** `scheduled: true` in the payload (queued by launchd via enqueue.sh, marked by the API). */
  scheduled: boolean;
  /** Inbox items the API holds for this job (WebUI uploads, URLs, memos). */
  inbox: { name: string }[];
}

export interface IngestPlan {
  /** Job ids, the lead (the one /jobs/next handed out) first. `result.batch` of every done body. */
  ids: string[];
  /** At least one job is the scheduled run: build and push one ops digest. */
  scheduled: boolean;
  /** Nothing to do: every job is a scheduled run and the inbox (after staging) is empty. The agent is not started. */
  skip: boolean;
  /** Names of the inputs the jobs brought (for the commit message / summary). */
  inputs: string[];
  /** Everything in 000_inbox when the run starts (collector output, mails, staged items), for the digest. */
  inboxNames: string[];
}

export interface IngestOutcome {
  ok: boolean;
  /** Tail of the agent output (absent when skipped). */
  summary?: string;
  /** Set when the run was skipped (idle scheduled run). */
  skipped?: boolean;
  commit?: string | null;
  /** Full agent output, kept only to build the digest (never put in a done body). */
  agentOutput?: string;
  /** Ops digest: full text for the job result, title/body for the single push (lead job only). */
  digest?: { text: string; notify: { title: string; body: string } };
}

export const SKIP_SUMMARY = "inbox が空のため skip（agent は起動していない）";

/** Decide how the batch runs. `inboxNames` is what 000_inbox holds after every job's inputs were staged. */
export function planIngest(jobs: BatchJob[], inboxNames: string[]): IngestPlan {
  if (!jobs.length) throw new Error("planIngest: no jobs");
  const inputs = jobs.flatMap((j) => j.inbox.map((i) => i.name));
  const allScheduled = jobs.every((j) => j.scheduled);
  return {
    ids: jobs.map((j) => j.id),
    scheduled: jobs.some((j) => j.scheduled),
    skip: allScheduled && inboxNames.length === 0 && inputs.length === 0,
    inputs,
    inboxNames,
  };
}

/** `ingest: a.pdf, memo.md` for WebUI inputs, `ingest: inbox` for a plain run (same wording as before batching). */
export function ingestCommitMessage(plan: IngestPlan): string {
  return `ingest: ${plan.inputs.join(", ") || "inbox"}`;
}

/**
 * One `done` body per job. All jobs share the outcome; `batch` (when more than one) tells the API and the Jobs page
 * which jobs ran together, and only the lead job carries `notify` so the digest is pushed once.
 */
export function ingestDoneBodies(plan: IngestPlan, outcome: IngestOutcome): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const batch = plan.ids.length > 1 ? plan.ids : undefined;
  for (const [i, id] of plan.ids.entries()) {
    const result: Record<string, unknown> = outcome.skipped ? { summary: SKIP_SUMMARY, skipped: true } : { summary: outcome.summary ?? "" };
    if (batch) result.batch = batch;
    if (outcome.digest) result.digest = outcome.digest.text;
    const body: Record<string, unknown> = { ok: outcome.ok, result, commit: outcome.commit ?? null };
    if (i === 0 && outcome.digest) body.notify = outcome.digest.notify;
    out.set(id, body);
  }
  return out;
}

/** The whole batch failed before it could report (staging, kb build, an exception): the same error on every job. */
export function ingestFailureBodies(ids: string[], error: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const id of ids) out.set(id, { ok: false, result: ids.length > 1 ? { error, batch: ids } : { error } });
  return out;
}
