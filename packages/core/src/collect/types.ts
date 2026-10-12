/**
 * Bronze collectors: pull raw data from external services into 000_inbox as JSON.
 *
 * Each data source is a self-contained Collector (its own auth, range, pagination and rate handling — the
 * "sub-agent" unit). The orchestrator (run.ts) only asks each one whether it is configured, runs them
 * in parallel and isolates failures. Adding a source = one file in sources/ + one line in registry.ts.
 */
import type { KbConfig } from "../config";
import type { HttpClient } from "./http";
import type { GoogleAuth } from "./google";

export type Env = Record<string, string | undefined>;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface CollectContext {
  cfg: KbConfig;
  env: Env;
  /** Window to collect: [from, to). `from` defaults to the source's cursor, else `to - lookbackDays`. */
  from: Date;
  to: Date;
  /** Opaque per-source state saved after a successful run (e.g. last seen id). */
  cursor: string | undefined;
  http: HttpClient;
  google: GoogleAuth;
  log: Logger;
  dryRun: boolean;
}

/** One file to drop into the inbox. `name` must start with the prefix ingest knows (`collect-…` / `mail-…`). */
export interface InboxFile {
  name: string;
  json: unknown;
}

export interface CollectResult {
  /** Feed items for the standard envelope file collect-<id>-<from>_<to>.json. Empty → no file. */
  items?: unknown[];
  /** Extra metadata stored in the envelope next to items. */
  meta?: Record<string, unknown>;
  /** Files written as-is (Gmail writes one mail-*.json per message). */
  files?: InboxFile[];
  /** New cursor; saved only when the whole run succeeded. */
  cursor?: string;
  /** Override the window recorded in the envelope / state (e.g. health only covers complete days). */
  from?: Date;
  to?: Date;
  /** Called after the inbox files are written (e.g. Gmail labels the messages as fetched). Not called on --dry-run. */
  commit?: () => Promise<void>;
}

export interface Collector {
  /** Short id used in file names (collect-<id>-…) and state. */
  readonly id: string;
  readonly label: string;
  /** Days to look back on the first run (no cursor yet). */
  readonly lookbackDays: number;
  /** true, or the reason it is skipped (missing token, …). Skipping is not a failure. */
  configured(env: Env): true | string;
  collect(ctx: CollectContext): Promise<CollectResult>;
  /** One line per item for `kb source` (the ingest agent reads this instead of the raw JSON). */
  digest(item: unknown): string;
}

/** Envelope of collect-*.json files. Raw API objects stay untouched in `items`. */
export interface Feed<T = unknown> {
  source: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD, exclusive
  collected_at: string;
  count: number;
  meta?: Record<string, unknown>;
  items: T[];
}
