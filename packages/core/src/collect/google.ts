/** Google OAuth for the collectors: one Desktop-app client and one refresh token shared by Gmail / Calendar / YouTube / Health. */
import { createHash, randomBytes } from "node:crypto";
import type { HttpClient } from "./http";
import type { Env } from "./types";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read KB/* mail, add the KB/取込済 label
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
];
/**
 * The Google Health API rejects any token that also carries non-health scopes (403 DISALLOWED_OAUTH_SCOPES),
 * so it gets its own consent and refresh token (same OAuth client): `bun run collect auth google-health`.
 */
export const GOOGLE_HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface GoogleAuth {
  configured: true | string;
  accessToken(): Promise<string>;
}

export function createGoogleAuth(env: Env, http: HttpClient, opts: { refreshTokenVar?: string; authCommand?: string } = {}): GoogleAuth {
  const tokenVar = opts.refreshTokenVar ?? "GOOGLE_REFRESH_TOKEN";
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", tokenVar].filter((k) => !env[k]);
  let cached: { token: string; exp: number } | null = null;
  let inflight: Promise<string> | null = null;
  return {
    configured: missing.length ? `missing ${missing.join(", ")} (run: bun run collect ${opts.authCommand ?? "auth google"})` : true,
    async accessToken() {
      if (missing.length) throw new Error(`Google auth not configured: missing ${missing.join(", ")}`);
      if (cached && cached.exp > Date.now() + 60_000) return cached.token;
      // collectors run in parallel: share one refresh instead of racing four
      inflight ??= (async () => {
        try {
          const r = await http.json<{ access_token: string; expires_in: number }>(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
              refresh_token: env[tokenVar]!, grant_type: "refresh_token",
            }),
          });
          cached = { token: r.access_token, exp: Date.now() + r.expires_in * 1000 };
          return r.access_token;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}

/** GET/POST a Google API with the shared bearer token. */
export async function googleJson<T>(http: HttpClient, auth: GoogleAuth, url: string, init: RequestInit = {}): Promise<T> {
  const token = await auth.accessToken();
  return http.json<T>(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
}

/**
 * Interactive consent (run by hand once): loopback redirect on 127.0.0.1 with PKCE, returns the refresh token.
 * The caller writes it into the collector's .env; it is never printed.
 */
export async function authorizeGoogle(env: Env, opts: { port?: number; open?: (url: string) => void; scopes?: string[] } = {}): Promise<{ refreshToken: string; scopes: string }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in apps/collector/.env first");
  const port = opts.port ?? 8789;
  const redirect = `http://127.0.0.1:${port}/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: (opts.scopes ?? GOOGLE_SCOPES).join(" "),
    access_type: "offline", prompt: "consent", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
        setTimeout(() => server.stop(), 100);
        if (u.searchParams.get("state") !== state) { reject(new Error("OAuth state mismatch")); return new Response("state mismatch", { status: 400 }); }
        const c = u.searchParams.get("code");
        if (!c) { reject(new Error(`consent failed: ${u.searchParams.get("error") ?? "no code"}`)); return new Response("consent failed", { status: 400 }); }
        resolve(c);
        return new Response("my-knowledge collector: 認可しました。このタブは閉じて構いません。", { headers: { "content-type": "text/plain; charset=utf-8" } });
      },
    });
    (opts.open ?? ((u) => Bun.spawn(["open", u])))(url);
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: verifier,
      redirect_uri: redirect, grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) throw new Error(`token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  return { refreshToken: body.refresh_token, scopes: body.scope ?? "" };
}
