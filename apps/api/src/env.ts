export const env = {
  port: Number(process.env.PORT ?? 8787),
  kbRoot: process.env.KB_ROOT ?? "/data/kb",
  dataDir: process.env.DATA_DIR ?? "/data/app", // jobs.sqlite, staging inbox
  webDist: process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname,
  // Cloudflare Access
  cfTeamDomain: process.env.CF_ACCESS_TEAM_DOMAIN ?? "", // e.g. myteam.cloudflareaccess.com
  cfAud: process.env.CF_ACCESS_AUD ?? "",
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  workerServiceTokenName: process.env.WORKER_SERVICE_TOKEN_NAME ?? "", // Client ID of the Access service token (JWT common_name)
  workerToken: process.env.WORKER_TOKEN ?? "", // optional shared secret as a second factor / dev
  devBypassAuth: process.env.DEV_BYPASS_AUTH === "1",
  gitAuthor: process.env.GIT_AUTHOR ?? "kb-web <kb-web@local>",
  syncIntervalSec: Number(process.env.SYNC_INTERVAL_SEC ?? 300),
};
