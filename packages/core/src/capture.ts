/**
 * Captures: AI research (a Gemini / Claude / ChatGPT / NotebookLM / Perplexity conversation, a Claude Code session) and
 * anything shared from the phone, sent to one API (`POST /api/captures`) by every client — the Chrome extension, the
 * `kb capture` CLI (the `save-research` skill) and the WebUI share target. The API turns a capture into an inbox item
 * (`capture-<platform>-<slug>-<hash>.md`) and an ingest job; the worker reports back which Bronze item and Silver notes
 * each staged inbox item became, and every client reads the same status from `GET /api/captures/:id`.
 *
 * The same conversation sent again is one `key` (platform + conversation id): an unchanged body is answered as a
 * duplicate, a changed one becomes the next version, and the inbox file lists the notes the previous version went to
 * (`previous_notes`), so the ingest updates those notes instead of starting new ones.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { KbConfig } from "./config";
import { readMeta, type BronzeMeta } from "./bronze";

export const CAPTURE_CLIENTS = ["chrome", "claude-code", "share", "cli"] as const;
export const CAPTURE_PLATFORMS = ["gemini", "claude", "chatgpt", "notebooklm", "perplexity", "claude-code", "web"] as const;
export type CaptureClient = (typeof CAPTURE_CLIENTS)[number];
export type CapturePlatform = (typeof CAPTURE_PLATFORMS)[number];
export type CaptureArea = "work" | "personal";
/** Largest body accepted (the extension caps a note at 8 MiB by default; the inbox item is kept in SQLite). */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export interface CaptureInput {
  client: CaptureClient;
  platform: CapturePlatform;
  /** The conversation / session id on the platform. Absent (a shared page) → the URL, else the body, identifies it. */
  conversation_id?: string;
  url?: string;
  title: string;
  /** The whole conversation (or report) as Markdown. May be empty for a shared URL. */
  markdown: string;
  /** Unset → decided by the ingest (a work account / work content goes to 207_work). */
  area?: CaptureArea;
  /** Why it was saved, what to keep (written by the person). */
  note?: string;
  /** The account on the platform, e.g. `work` for the company Google account. */
  account?: string;
  /** When the conversation was captured on the client (ISO). */
  captured_at?: string;
}

const str = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate a request body. Returns the cleaned input or an error message. */
export function parseCapture(body: unknown): { ok: true; value: CaptureInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "JSON object required" };
  const b = body as Record<string, unknown>;
  const client = b.client as CaptureClient;
  if (!CAPTURE_CLIENTS.includes(client)) return { ok: false, error: `client must be one of ${CAPTURE_CLIENTS.join(", ")}` };
  const platform = b.platform as CapturePlatform;
  if (!CAPTURE_PLATFORMS.includes(platform)) return { ok: false, error: `platform must be one of ${CAPTURE_PLATFORMS.join(", ")}` };
  const markdown = typeof b.markdown === "string" ? b.markdown : "";
  const url = str(b.url);
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "url must be http(s)" };
  if (!markdown.trim() && !url) return { ok: false, error: "markdown or url required" };
  if (Buffer.byteLength(markdown) > CAPTURE_MAX_BYTES) return { ok: false, error: `markdown above ${CAPTURE_MAX_BYTES} bytes` };
  const area = b.area === "work" || b.area === "personal" ? b.area : undefined;
  if (b.area != null && b.area !== "" && !area) return { ok: false, error: "area must be work or personal" };
  const title = str(b.title, 200) ?? (url ? url : markdown.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 80)) ?? "capture";
  return {
    ok: true,
    value: {
      client, platform, title, markdown, url,
      conversation_id: str(b.conversation_id, 200), area, note: str(b.note), account: str(b.account, 100), captured_at: str(b.captured_at, 40),
    },
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const contentHash = (c: Pick<CaptureInput, "markdown" | "url">) => sha256(`${c.url ?? ""}\n${c.markdown}`);

/** Identity of the thing captured, stable across re-syncs: `<platform>:<conversation id | url | body hash>`. */
export function captureKey(c: Pick<CaptureInput, "platform" | "conversation_id" | "url" | "markdown">): string {
  const id = c.conversation_id ?? (c.url ? `url:${sha256(c.url).slice(0, 16)}` : `body:${sha256(c.markdown).slice(0, 16)}`);
  return `${c.platform}:${id}`;
}

/** `capture-gemini-3f2a9c01b2-ab12cd34.md`: platform, a filesystem-safe part of the key, the content hash. */
export function captureFileName(key: string, hash: string): string {
  const [platform, ...rest] = key.split(":");
  const slug = rest.join(":").replace(/^(url|body):/, "").replace(/[^A-Za-z0-9_-]+/g, "").slice(-24) || "x";
  return `capture-${platform}-${slug}-${hash.slice(0, 8)}.md`;
}

export interface CaptureFileMeta { capture_id: string; key: string; version: number; hash: string; previous_notes: string[] }

/** The inbox file: YAML frontmatter (what the ingest needs to route and to update earlier notes), then the body as sent. */
export function renderCaptureFile(c: CaptureInput, meta: CaptureFileMeta): string {
  const fm: Record<string, unknown> = {
    capture_id: meta.capture_id, capture_key: meta.key, version: meta.version, client: c.client, platform: c.platform,
    title: c.title, url: c.url, conversation_id: c.conversation_id, account: c.account, area: c.area, note: c.note,
    captured_at: c.captured_at ?? new Date().toISOString(), content_hash: meta.hash,
    previous_notes: meta.previous_notes.length ? meta.previous_notes : undefined,
  };
  for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
  return `---\n${YAML.stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${c.markdown.trim() ? c.markdown.trim() : `${c.url}`}\n`;
}

/** What one staged inbox item became after an ingest run (reported by the worker in the job's `done`). */
export interface ItemOutcome {
  name: string;
  /** Bronze id, null when the agent left the item in the inbox. */
  bronze: string | null;
  /** Silver paths from the Bronze meta; `-` entries (reviewed, nothing to reflect) are dropped. */
  notes: string[];
  /** Bronze `processed_to` was set (to notes or to `-`). */
  processed: boolean;
}

/**
 * Find the Bronze items made from these inbox names (meta.source is the file name, or the URL for a fetched page).
 * Only the current and the previous month are scanned: the worker asks right after the run that ingested them.
 */
export function itemOutcomes(cfg: KbConfig, names: string[], now = new Date()): ItemOutcome[] {
  if (!names.length) return [];
  const wanted = new Set(names);
  const found = new Map<string, BronzeMeta>();
  const months = [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))].map((d) => [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0")]);
  for (const [y, m] of months) {
    const dir = join(cfg.bronze, y!, m!);
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir).sort()) {
      const meta = readMeta(cfg, id);
      if (meta && wanted.has(meta.source)) found.set(meta.source, meta); // later ids win (sorted)
    }
  }
  return names.map((name) => {
    const m = found.get(name);
    return { name, bronze: m?.id ?? null, notes: (m?.processed_to ?? []).filter((p) => p !== "-"), processed: !!m?.processed_to.length };
  });
}
