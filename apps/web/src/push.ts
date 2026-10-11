import { api } from "./api";

export type PushState = "unsupported" | "disabled" | "denied" | "off" | "on";

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function toKey(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Current state for the button: unsupported (iOS Safari outside a Home-Screen app), disabled (no VAPID key on the server), denied, off, on. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const { publicKey } = await api.pushVapid();
  if (!publicKey) return "disabled";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "on" : "off";
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const { publicKey } = await api.pushVapid();
  if (!publicKey) return "disabled";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) as BufferSource }));
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api.pushUnsubscribe(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
  return "off";
}
