import webpush, { WebPushError, type PushSubscription } from "web-push";
import { env } from "./env";
import { deletePushSubscription, listPushSubscriptions } from "./store";

export interface PushPayload { title: string; body?: string; url?: string; tag?: string }

let configured = false;
/** True when VAPID keys are set; the web UI hides the subscribe button otherwise. */
export function pushEnabled(): boolean {
  return Boolean(env.vapidPublicKey && env.vapidPrivateKey);
}
function setup() {
  if (configured || !pushEnabled()) return;
  const subject = env.vapidSubject || (env.allowedEmails[0] ? `mailto:${env.allowedEmails[0]}` : "mailto:admin@example.com");
  webpush.setVapidDetails(subject, env.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
}

/** Send one notification to every stored subscription. Gone subscriptions (404/410) are deleted. Never throws. */
export async function sendPushToAll(p: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const r = { sent: 0, removed: 0, failed: 0 };
  if (!pushEnabled()) return r;
  setup();
  const payload = JSON.stringify({ tag: "kb", ...p });
  await Promise.all(listPushSubscriptions().map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.json) as PushSubscription, payload, { TTL: 12 * 3600, urgency: "high" });
      r.sent++;
    } catch (e) {
      const code = e instanceof WebPushError ? e.statusCode : 0;
      if (code === 404 || code === 410) { deletePushSubscription(row.endpoint); r.removed++; }
      else { r.failed++; console.error(`push: ${row.endpoint.slice(0, 40)}… ${code || (e as Error).message}`); }
    }
  }));
  return r;
}

/** The ask-done notification: one line of the question as the title, the answer's first ~200 chars (whitespace folded) as the body. */
export function askDonePush(question: string, answer: string, id: string): PushPayload {
  const one = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  return { title: `回答: ${one(question, 60) || "(質問なし)"}`, body: one(answer, 200), url: "/chat", tag: `ask-${id}` };
}
