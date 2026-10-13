/**
 * Lifetimes of the collector's credentials: the Google refresh tokens (7 days while the consent screen is in Testing)
 * and the GitHub fine-grained PAT (expiry date chosen on creation, recorded by hand as GITHUB_TOKEN_EXPIRES).
 * `collect status` prints them, the daily run warns ahead (macOS notification) and leaves the expiry dates in
 * 900_system/cache/collect-tokens.json so the morning ops digest (worker, no access to the .env) can show days left.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "../config";
import { DAY_MS } from "./dates";
import { GOOGLE_TOKENS, tokenExpiry } from "./google";
import type { Env } from "./types";

export interface TokenStatus {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  issuedAt?: Date;
  expiresAt?: Date;
  /** Fractional days until `expiresAt`; negative = expired. Undefined when the expiry is unknown / none. */
  daysLeft?: number;
  /** Warn when daysLeft is at or below this. */
  warnDays: number;
  /** What to do to renew. */
  renew: string;
}

export const GITHUB_WARN_DAYS = 7;
export const GOOGLE_WARN_DAYS = 1.5;

/** GITHUB_TOKEN_EXPIRES=YYYY-MM-DD (the date GitHub shows for the PAT), taken as the start of that day (local). */
export function githubTokenExpiry(env: Env, now = new Date()): { expiresAt?: Date; daysLeft?: number } {
  const raw = env.GITHUB_TOKEN_EXPIRES?.trim();
  if (!raw) return {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return {};
  const expiresAt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (expiresAt.getMonth() !== Number(m[2]) - 1 || expiresAt.getDate() !== Number(m[3])) return {}; // rolled over: not a real date
  return { expiresAt, daysLeft: (expiresAt.getTime() - now.getTime()) / DAY_MS };
}

/** Every credential with a lifetime, configured or not, in a stable order. */
export function tokenStatuses(env: Env, now = new Date()): TokenStatus[] {
  const out: TokenStatus[] = GOOGLE_TOKENS.map((t) => {
    const { issuedAt, expiresAt, daysLeft } = env[t.envVar] ? tokenExpiry(env, t.envVar, now) : {};
    return { id: t.name, label: t.label, envVar: t.envVar, configured: !!env[t.envVar], issuedAt, expiresAt, daysLeft, warnDays: GOOGLE_WARN_DAYS, renew: `bun run collect auth ${t.name}` };
  });
  const gh = env.GITHUB_TOKEN ? githubTokenExpiry(env, now) : {};
  out.push({ id: "github", label: "GitHub PAT", envVar: "GITHUB_TOKEN", configured: !!env.GITHUB_TOKEN, expiresAt: gh.expiresAt, daysLeft: gh.daysLeft, warnDays: GITHUB_WARN_DAYS, renew: "GitHub で再生成して GITHUB_TOKEN と GITHUB_TOKEN_EXPIRES を書き換える" });
  return out;
}

/**
 * Warning lines for the daily run: a token that died (`dead(status)`, e.g. a source failed with invalid_grant) or has
 * expired, and one that expires within its warnDays. Tokens that are not configured or have no known expiry are silent.
 */
export function tokenWarnings(statuses: TokenStatus[], dead: (s: TokenStatus) => boolean = () => false, fmt: (d: Date) => string = (d) => d.toISOString().slice(0, 10)): string[] {
  const out: string[] = [];
  for (const s of statuses) {
    if (!s.configured) continue;
    if (dead(s) || (s.daysLeft !== undefined && s.daysLeft <= 0)) out.push(`${s.label} のトークンが切れました。${s.renew}`);
    else if (s.daysLeft !== undefined && s.daysLeft <= s.warnDays) out.push(`${s.label} のトークンは ${fmt(s.expiresAt!)} に切れます（残り ${formatDays(s.daysLeft)}）。${s.renew}`);
  }
  return out;
}

export const formatDays = (d: number) => (d >= 10 ? `${Math.floor(d)} 日` : `${d.toFixed(1)} 日`);

// --- hand-off to the ops digest (expiry dates only; no token values) ---

export interface TokenExpiryRecord { id: string; label: string; expiresAt: string | null; warnDays: number }
export interface TokenDays { id: string; label: string; daysLeft: number; warnDays: number }

export const tokensPath = (cfg: KbConfig) => join(cfg.cache, "collect-tokens.json");

/** Written by every (non-dry) collect run: configured tokens and when they expire (null = no known expiry). */
export function saveTokenExpiries(cfg: KbConfig, statuses: TokenStatus[], now = new Date()): void {
  const tokens: TokenExpiryRecord[] = statuses.filter((s) => s.configured).map((s) => ({ id: s.id, label: s.label, expiresAt: s.expiresAt?.toISOString() ?? null, warnDays: s.warnDays }));
  mkdirSync(cfg.cache, { recursive: true });
  const p = tokensPath(cfg);
  writeFileSync(`${p}.tmp`, JSON.stringify({ writtenAt: now.toISOString(), tokens }, null, 2));
  renameSync(`${p}.tmp`, p);
}

/** Days left per token with a known expiry, from the file the collector left (empty when it never ran). */
export function loadTokenDays(cfg: KbConfig, now = new Date()): TokenDays[] {
  const p = tokensPath(cfg);
  let tokens: TokenExpiryRecord[] = [];
  try { if (existsSync(p)) tokens = (JSON.parse(readFileSync(p, "utf8")) as { tokens?: TokenExpiryRecord[] }).tokens ?? []; } catch { return []; }
  const out: TokenDays[] = [];
  for (const t of tokens) {
    if (!t.expiresAt || Number.isNaN(Date.parse(t.expiresAt))) continue;
    out.push({ id: t.id, label: t.label, daysLeft: (Date.parse(t.expiresAt) - now.getTime()) / DAY_MS, warnDays: t.warnDays ?? 0 });
  }
  return out;
}
