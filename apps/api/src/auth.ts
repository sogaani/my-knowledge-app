import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import { env } from "./env";

export type Principal =
  | { kind: "user"; email: string }
  | { kind: "worker"; name: string }
  | { kind: "service"; name: string }; // external pushers (GAS); may only write to /api/inbox

const jwks = env.cfTeamDomain ? createRemoteJWKSet(new URL(`https://${env.cfTeamDomain}/cdn-cgi/access/certs`)) : null;

async function verifyAccess(token: string): Promise<Principal | null> {
  if (!jwks) return null;
  const { payload } = await jwtVerify(token, jwks, { issuer: `https://${env.cfTeamDomain}`, audience: env.cfAud });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (email && env.allowedEmails.includes(email)) return { kind: "user", email };
  const cn = typeof payload.common_name === "string" ? payload.common_name : null;
  if (cn && env.workerServiceTokenName && cn === env.workerServiceTokenName) return { kind: "worker", name: cn };
  if (cn && env.ingestServiceTokenName && cn === env.ingestServiceTokenName) return { kind: "service", name: cn };
  return null;
}

/** Hono middleware: sets c.var.principal or returns 401/403. */
export async function authenticate(c: Context, next: Next) {
  let p: Principal | null = null;
  if (env.devBypassAuth) {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer && env.workerToken && bearer === env.workerToken) p = { kind: "worker", name: "dev" };
    else if (bearer && env.ingestToken && bearer === env.ingestToken) p = { kind: "service", name: "dev" };
    else p = { kind: "user", email: env.allowedEmails[0] ?? "dev@local" };
  } else {
    const jwt = c.req.header("cf-access-jwt-assertion") ?? c.req.header("cf-access-jwt-assertion".toUpperCase());
    if (jwt) {
      try { p = await verifyAccess(jwt); } catch { p = null; }
    }
    // service-token principals must additionally present their shared token (defence in depth); required when set
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (p?.kind === "worker" && env.workerToken && bearer !== env.workerToken) p = null;
    if (p?.kind === "service" && env.ingestToken && bearer !== env.ingestToken) p = null;
  }
  if (!p) return c.json({ error: "unauthorized" }, 401);
  c.set("principal", p);
  await next();
}

export async function requireWorker(c: Context, next: Next): Promise<Response | void> {
  const p = c.get("principal") as Principal;
  if (p.kind !== "worker") return c.json({ error: "worker only" }, 403);
  await next();
}
export async function requireUser(c: Context, next: Next): Promise<Response | void> {
  const p = c.get("principal") as Principal;
  if (p.kind !== "user") return c.json({ error: "user only" }, 403);
  await next();
}
/** POST /api/inbox: the owner (web UI) or an external pusher such as the Gmail Apps Script. */
export async function requireInboxWriter(c: Context, next: Next): Promise<Response | void> {
  const p = c.get("principal") as Principal;
  if (p.kind !== "user" && p.kind !== "service") return c.json({ error: "user or service only" }, 403);
  await next();
}
/** POST /api/jobs: the owner or the Mac worker (launchd schedules enqueue via the worker token). */
export async function requireUserOrWorker(c: Context, next: Next): Promise<Response | void> {
  const p = c.get("principal") as Principal;
  if (p.kind !== "user" && p.kind !== "worker") return c.json({ error: "user or worker only" }, 403);
  await next();
}
