export interface NoteSummary { path: string; type: string; title: string; status: string; summary: string; tags: string[]; fm: Record<string, unknown>; archived: boolean; updated: string }
/** `attachment`: set when a log.md / tasks.md path was asked for; the payload is then its folder entity's README note. */
export interface NoteDetail { path: string; type: string; title: string; fm: Record<string, unknown>; body: string; archived: boolean; links: string[]; backlinks: string[]; attachments: Record<string, string>; attachment?: string }
export interface Job { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; payload: string; result: string | null; log: string; commit: string | null; created_at: string; started_at: string | null; finished_at: string | null }
export interface ChatMessage { id: string; role: "user" | "assistant"; text: string; sources: string; job_id: string | null; created_at: string }
export interface SearchMatch { path: string; heading: string; snippet: string; spoiler: boolean; via: ("vector" | "keyword")[] }
export interface SearchHit { path: string; type: string; title: string; status: string; summary: string; tags: string[]; updated: string; archived: boolean; score: number; matches: SearchMatch[] }
export interface SearchResponse { hits: SearchHit[]; mode: "hybrid" | "vector" | "keyword"; degraded?: string; job?: string; queuedMs?: number | null; workerMs?: number | null }
export interface TypeDef { type: string; folder: string; entity: string; statuses: string[]; fields: string[] }
export interface Home {
  counts: { type: string; c: number }[]; monthlySubscriptions: { currency: string; amount: number }[]; activeSubscriptions: number; // monthly totals per currency, never summed across
  books: Record<string, number>; media: Record<string, number>; projects: NoteSummary[]; recent: NoteSummary[]; jobs: Job[];
  lint: Record<string, string[]>; head: string; unpushed?: number; pushError?: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string; errors?: string[] };
    throw new Error([b.error ?? res.statusText, ...(b.errors ?? [])].join(": "));
  }
  return res.json() as Promise<T>;
}
/** Type definitions only change with a deploy: fetch once per page load. */
let typesCache: Promise<TypeDef[]> | null = null;
export const api = {
  home: () => req<Home>("/home"),
  types: () => (typesCache ??= req<TypeDef[]>("/types").catch((e) => { typesCache = null; throw e; })),
  notes: (p: Record<string, string>) => req<NoteSummary[]>(`/notes?${new URLSearchParams(p)}`),
  note: (path: string) => req<NoteDetail>(`/notes/${path}`),
  search: (p: Record<string, string>) => req<SearchResponse>(`/search?${new URLSearchParams(p)}`),
  /** Answers with the updated note, so the page can render it without another GET. */
  patch: (path: string, body: { fm?: Record<string, unknown>; append?: { section: string; line: string } }) => req<NoteDetail>(`/notes/${path}`, { method: "PATCH", body: JSON.stringify(body) }),
  create: (body: { type: string; title: string; set?: Record<string, unknown>; force?: boolean }) => req<{ path: string }>("/notes", { method: "POST", body: JSON.stringify(body) }),
  gold: (name: string) => req<{ markdown: string }>(`/gold/${name}`),
  react: (body: { id: string; reaction: "read" | "dismissed"; title?: string; type?: "book" | "media" }) => req<{ ok: boolean; created: string | null }>("/suggestions/react", { method: "POST", body: JSON.stringify(body) }),
  inboxJson: (body: { url?: string; text?: string; title?: string }) => req<{ job: Job }>("/inbox", { method: "POST", body: JSON.stringify(body) }),
  inboxForm: async (form: FormData) => { const r = await fetch("/api/inbox", { method: "POST", body: form }); if (!r.ok) throw new Error(await r.text()); return r.json() as Promise<{ job: Job }>; },
  jobs: () => req<Job[]>("/jobs"),
  job: (id: string) => req<Job>(`/jobs/${id}`),
  runJob: (kind: string, payload?: unknown) => req<Job>("/jobs", { method: "POST", body: JSON.stringify({ kind, payload }) }),
  chat: () => req<ChatMessage[]>("/chat"),
  ask: (question: string) => req<{ message: ChatMessage; job: Job }>("/chat", { method: "POST", body: JSON.stringify({ question }) }),
  sync: () => req<{ changed: boolean }>("/sync", { method: "POST" }),
  build: () => req<{ files: string[] }>("/build", { method: "POST" }),
  pushVapid: () => req<{ publicKey: string | null; subscriptions: number }>("/push/vapid"),
  pushSubscribe: (sub: PushSubscriptionJSON) => req<{ ok: boolean }>("/push/subscribe", { method: "POST", body: JSON.stringify(sub) }),
  pushUnsubscribe: (endpoint: string) => req<{ ok: boolean }>("/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  pushTest: () => req<{ sent: number; removed: number; failed: number }>("/push/test", { method: "POST" }),
};
