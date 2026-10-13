/**
 * Operations digest and log hygiene for the Mac worker and the API.
 *
 * After the scheduled morning ingest the worker builds one OpsDigest (what the collectors brought in, what the
 * agent wrote, where it hesitated, what is piling up) and the API pushes it as a single notification. The
 * helpers here are pure where they can be so they are testable without a data repo.
 */
import { processState, walkBronze } from "./bronze";
import { lastBackupAt } from "./backup";
import { loadState, type CollectState } from "./collect/run";
import { formatDays, loadTokenDays, type TokenDays } from "./collect/tokens";
import type { Database } from "bun:sqlite";
import { SILVER_PREFIX, type KbConfig } from "./config";
import { resurface, splitEncrypted, type ResurfaceEntry } from "./resurface";

export interface CollectSourceSummary {
  id: string;
  status: "ok" | "failed" | "stale";
  /** Items (feed entries or files) written by the last successful run. */
  items: number;
  /** Head of the last error (already clipped by the collector). */
  error?: string;
  /** Hours since the last run (for `stale`). */
  ageHours?: number;
}

export interface OpsDigest {
  /** Local calendar date of the run (YYYY-MM-DD). */
  date: string;
  /** Per collector source, from collect-state.json. */
  collect: CollectSourceSummary[];
  /** What was waiting in 000_inbox when the ingest started. */
  inbox: { feeds: number; mails: number; other: number };
  /** Silver notes the agent created / changed (from git status before the commit). */
  notes: { created: number; updated: number };
  /** The agent's own "判断に迷った点" bullets. */
  judgements: string[];
  /** Bronze items with no processed_to yet. */
  unprocessedBronze: number;
  /** Days since the last real (non-dry) `kb backup`; null = never ran. */
  backupDays: number | null;
  /** Collector credentials with a known expiry (collect-tokens.json): days left, no values. Empty = the collector never wrote it. */
  tokens: TokenDays[];
  agentOk: boolean;
  /** Notes to look at again today (resurface.ts, the same list as Gold 393); null when the digest was built without the index. */
  review: { due: number; onThisDay: number; /** plaintext entries only (the digest text is stored in the API's job table) */ top: ResurfaceEntry[] } | null;
}

/** Collapse an HTTP error body (often a Cloudflare HTML page) to one line of at most `max` characters. */
export function clipError(text: string, max = 200): string {
  const t = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Head of a failed job's result for a notification: the error field when there is one, else the summary / JSON. */
export function errorHead(result: unknown, max = 140): string {
  let s: string;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    s = typeof r.error === "string" ? r.error : typeof r.summary === "string" ? r.summary : JSON.stringify(r);
  } else s = String(result ?? "");
  return clipError(s, max);
}

/** Per-source state → ok / failed / stale (not run within `staleHours`). Sorted by id so the digest is stable. */
export function summarizeCollect(state: CollectState, now = new Date(), staleHours = 36): CollectSourceSummary[] {
  return Object.entries(state).sort(([a], [b]) => a.localeCompare(b)).map(([id, st]) => {
    const items = st.lastItems ?? 0;
    if (st.lastError) return { id, status: "failed", items, error: clipError(st.lastError, 80) };
    const ageHours = st.lastRunAt ? (now.getTime() - new Date(st.lastRunAt).getTime()) / 3600_000 : Infinity;
    if (ageHours > staleHours) return { id, status: "stale", items, ageHours: Number.isFinite(ageHours) ? Math.round(ageHours) : undefined };
    return { id, status: "ok", items };
  });
}

/** Inbox file names → what kind of input the ingest got (collector feeds, Gmail mails, hand-dropped files). */
export function countInbox(names: string[]): OpsDigest["inbox"] {
  const c = { feeds: 0, mails: 0, other: 0 };
  for (const n of names) {
    if (/^collect-[a-z0-9]+-.*\.json$/i.test(n)) c.feeds++;
    else if (/^mail-.*\.json$/i.test(n)) c.mails++;
    else c.other++;
  }
  return c;
}

/** `git status --porcelain` entries → Silver notes created / updated. */
export function countNoteChanges(entries: { status: string; path: string }[]): OpsDigest["notes"] {
  const n = { created: 0, updated: 0 };
  for (const e of entries) {
    if (!e.path.startsWith(SILVER_PREFIX) || !e.path.endsWith(".md")) continue;
    if (e.status.startsWith("??") || e.status.startsWith("A")) n.created++;
    else if (e.status.includes("M")) n.updated++;
  }
  return n;
}

const BULLET = /^\s*(?:[-*・]|\d+[.)])\s+(.*)$/;
/**
 * The bullets under the agent's "判断に迷った点" heading (the ingest skill ends its report with them). Accepts
 * `**判断に迷った点**`, `判断に迷った点が 2 つあります。` and `- 判断に迷った点: …` forms; stops at the first non-bullet line.
 */
export function extractJudgements(agentOutput: string, max = 10): string[] {
  const lines = agentOutput.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes("迷った点"));
  if (i === -1) return [];
  const out: string[] = [];
  const inline = /迷った点[^:：]*[:：]\s*(.+)$/.exec(lines[i]!)?.[1]?.trim();
  if (inline && !/^(特に)?(なし|ありません|無し)/.test(inline)) out.push(inline);
  let j = i + 1;
  while (j < lines.length && !lines[j]!.trim()) j++;
  for (; j < lines.length && out.length < max; j++) {
    const m = BULLET.exec(lines[j]!);
    if (!m) break;
    const text = m[1]!.replace(/\*\*/g, "").trim();
    if (text) out.push(text);
  }
  return out;
}

export interface OpsDigestInput {
  now?: Date;
  /** Inbox file names present when the ingest started. */
  inboxNames: string[];
  agentOutput: string;
  agentOk: boolean;
  /** `gitStatusPaths` of Silver before the commit. */
  changes: { status: string; path: string }[];
  /** The note index (after `kb build`), for the "今日見直す" line; omitted = no such line. */
  db?: Database;
}

/** Read collect-state.json, Bronze and backup.log and combine them with what this ingest did. */
export function buildOpsDigest(cfg: KbConfig, input: OpsDigestInput): OpsDigest {
  const now = input.now ?? new Date();
  let unprocessedBronze = 0;
  for (const m of walkBronze(cfg)) if (processState(m) === "unprocessed") unprocessedBronze++;
  const backup = lastBackupAt(cfg);
  return {
    date: localDate(now),
    collect: summarizeCollect(loadState(cfg), now),
    inbox: countInbox(input.inboxNames),
    notes: countNoteChanges(input.changes),
    judgements: extractJudgements(input.agentOutput),
    unprocessedBronze,
    backupDays: backup ? Math.floor((now.getTime() - backup.getTime()) / 86400_000) : null,
    tokens: loadTokenDays(cfg, now),
    agentOk: input.agentOk,
    review: input.db ? reviewSummary(input.db, localDate(now)) : null,
  };
}

function reviewSummary(db: Database, date: string): OpsDigest["review"] {
  const r = resurface(db, date);
  return { due: r.due.length, onThisDay: r.onThisDay.length, top: splitEncrypted(r.due).plain.slice(0, 5) };
}

/** Title and a short body for the push notification (a few lines; platforms truncate beyond that). */
export function formatOpsDigest(d: OpsDigest): { title: string; body: string } {
  const [, m, day] = d.date.split("-");
  const title = `${d.agentOk ? "" : "[失敗] "}運用ダイジェスト ${Number(m)}/${Number(day)}`;
  const lines = [collectLine(d), notesLine(d)];
  if (d.tokens.length) lines.push(tokensLine(d.tokens));
  if (d.review) lines.push(reviewLine(d.review));
  if (d.judgements.length) {
    const first = d.judgements[0]!;
    lines.push(`迷った点 ${d.judgements.length}: ${first.length > 80 ? `${first.slice(0, 80)}…` : first}`);
  }
  return { title, body: lines.join("\n") };
}

/** The full digest as text, stored in the job result so the Jobs page shows everything the push abbreviated. */
export function renderOpsDigest(d: OpsDigest): string {
  const lines = [`# 運用ダイジェスト ${d.date}${d.agentOk ? "" : "（ingest 失敗）"}`, "", collectLine(d), `inbox: feed ${d.inbox.feeds} / mail ${d.inbox.mails} / その他 ${d.inbox.other}`, notesLine(d)];
  for (const s of d.collect) if (s.status === "failed") lines.push(`  ${s.id}: ${s.error}`);
  if (d.tokens.length) lines.push(tokensLine(d.tokens));
  if (d.review) {
    lines.push(reviewLine(d.review));
    for (const e of d.review.top) lines.push(`  ${e.title}: ${e.reason}`);
  }
  if (d.judgements.length) lines.push("", "迷った点:", ...d.judgements.map((j) => `- ${j}`));
  return lines.join("\n");
}

/** "今日見直すノート N 件" — the count on Gold 393 / the WebUI home, so the morning push leads there. */
function reviewLine(r: NonNullable<OpsDigest["review"]>): string {
  return `今日見直すノート ${r.due} 件${r.onThisDay ? ` · 同じ月日の過去ノート ${r.onThisDay} 件` : ""}`;
}

function collectLine(d: OpsDigest): string {
  if (!d.collect.length) return "収集: 記録なし";
  const parts = d.collect.map((s) => s.status === "ok" ? `${s.id} ${s.items}` : s.status === "failed" ? `${s.id} 失敗` : `${s.id} 未実行${s.ageHours !== undefined ? ` ${Math.round(s.ageHours / 24)}d` : ""}`);
  return `収集: ${parts.join(" · ")}`;
}
/** "トークン残日数: …" — expired or within warnDays gets a marker so the push is enough to know a renewal is due. */
export function tokensLine(tokens: TokenDays[]): string {
  const parts = tokens.map((t) => t.daysLeft <= 0 ? `${t.label} 期限切れ` : `${t.label} ${formatDays(t.daysLeft)}${t.daysLeft <= t.warnDays ? "（要更新）" : ""}`);
  return `トークン残日数: ${parts.join(" · ")}`;
}
function notesLine(d: OpsDigest): string {
  const backup = d.backupDays === null ? "未実施" : d.backupDays === 0 ? "今日" : `${d.backupDays} 日前`;
  return `ノート: 新規 ${d.notes.created} / 更新 ${d.notes.updated} · 未処理 Bronze ${d.unprocessedBronze} · バックアップ ${backup}`;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
