/** fetch with retries: exponential backoff + full jitter, honouring Retry-After and X-RateLimit-Reset. */

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body: string) {
    super(`HTTP ${status} ${redactUrl(url)}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export interface RetryPolicy {
  retries: number; // retries after the first attempt
  baseMs: number;
  maxMs: number;
  timeoutMs: number; // per attempt
}
export const DEFAULT_RETRY: RetryPolicy = { retries: 5, baseMs: 1000, maxMs: 60_000, timeoutMs: 30_000 };

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  json<T>(url: string, init?: RequestInit): Promise<T>;
}

/** Query strings can carry keys or tokens: never echo them into errors or logs. */
export function redactUrl(url: string): string {
  return url.replace(/\?.*$/, "?…");
}

/** Google APIs report quota / rate limits as 403 with these reasons in the body (no Retry-After). */
const GOOGLE_RATE_LIMIT = /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED/;
const PER_MINUTE_QUOTA = /per minute|PerMinute/i;

/**
 * Whether a failed response is worth retrying, and how long the server asked us to wait (ms), if it said.
 * `body` (when read) lets a 403 rate limit (Google) be told apart from a real permission error.
 */
export function retryDecision(res: Pick<Response, "status" | "headers">, now = Date.now(), body = ""): { retry: boolean; waitMs?: number } {
  const h = res.headers;
  const retryAfter = h.get("retry-after");
  let waitMs: number | undefined;
  if (retryAfter) {
    const secs = Number(retryAfter);
    waitMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - now);
  }
  // GitHub: primary rate limit → 403/429 with remaining 0 and a reset epoch
  const remaining = h.get("x-ratelimit-remaining");
  const reset = h.get("x-ratelimit-reset");
  const rateLimited = remaining === "0" && !!reset;
  if (rateLimited && waitMs === undefined) waitMs = Math.max(0, Number(reset) * 1000 - now) + 1000;
  if (res.status === 429 || res.status >= 500) return { retry: true, waitMs };
  if (res.status === 403 && (rateLimited || retryAfter)) return { retry: true, waitMs };
  // per-minute quotas refill within a minute: wait the window out instead of hammering with short backoffs
  if (res.status === 403 && GOOGLE_RATE_LIMIT.test(body)) return { retry: true, waitMs: waitMs ?? (PER_MINUTE_QUOTA.test(body) ? 61_000 : undefined) };
  return { retry: false };
}

export function backoffMs(attempt: number, p: RetryPolicy, random = Math.random): number {
  return Math.floor(random() * Math.min(p.maxMs, p.baseMs * 2 ** attempt));
}

export function createHttp(opts: { policy?: Partial<RetryPolicy>; sleep?: Sleep; fetchImpl?: typeof fetch; onRetry?: (msg: string) => void } = {}): HttpClient {
  const p = { ...DEFAULT_RETRY, ...opts.policy };
  const sleep = opts.sleep ?? realSleep;
  const doFetch = opts.fetchImpl ?? fetch;

  async function fetchRetry(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let err: unknown;
      try {
        res = await doFetch(url, { ...init, signal: AbortSignal.timeout(p.timeoutMs) });
      } catch (e) {
        err = e; // network error / timeout: retryable
      }
      if (res?.ok) return res;
      const body = res && res.status === 403 ? await res.text().catch(() => "") : undefined;
      const d = res ? retryDecision(res, Date.now(), body) : { retry: true as const, waitMs: undefined };
      if (!d.retry || attempt >= p.retries) {
        if (res) throw new HttpError(res.status, url, body ?? (await res.text().catch(() => "")));
        throw err;
      }
      // a server-provided wait longer than maxMs is still honoured (GitHub resets can be ~minutes away)
      const wait = d.waitMs ?? backoffMs(attempt, p);
      opts.onRetry?.(`${res ? `HTTP ${res.status}` : String((err as Error)?.message ?? err)} ${redactUrl(url)} → retry ${attempt + 1}/${p.retries} in ${Math.round(wait / 1000)}s`);
      if (body === undefined) await res?.body?.cancel().catch(() => {});
      await sleep(wait);
    }
  }

  return {
    fetch: fetchRetry,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      // some endpoints answer 200/204 with no body (Gmail messages.batchModify)
      const text = await (await fetchRetry(url, init)).text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight (keeps per-API concurrency polite). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
