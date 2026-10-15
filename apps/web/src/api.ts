/** `viewed`: when the note page was last shown (API `views` table), null = never. */
export interface NoteSummary { path: string; type: string; title: string; status: string; summary: string; tags: string[]; fm: Record<string, unknown>; archived: boolean; updated: string; viewed?: string | null }
export interface SimilarNote { path: string; type: string; title: string; status: string; summary: string; score: number }
/** Header fields of a note (title etc.), as the API resolves them for chat sources and prev/next links. */
export interface NoteHead { path: string; type: string; title: string; status: string; summary: string }
/** `attachment`: set when a log.md / tasks.md path was asked for; the payload is then its folder entity's README note. */
export interface NoteDetail {
  path: string; type: string; title: string; fm: Record<string, unknown>; body: string; archived: boolean; links: string[]; backlinks: string[]; attachments: Record<string, string>; attachment?: string;
  /** Nearest notes by embedding (from `kb embed`); empty until the Mac has embedded and pushed. */
  similar: SimilarNote[];
  /** The view before this one, and how many times the page was shown before. */
  viewed?: string | null; views?: number;
  /** Neighbours in the type's list (the order of /notes/:type): null at either end. */
  prev: NoteHead | null; next: NoteHead | null;
}
/** What to look at again today (Gold 393): due for review, written on this day in an earlier year, three random picks. */
export interface ResurfaceEntry { path: string; type: string; title: string; status: string; summary: string; encrypted: boolean; reason: string; date: string; overdue?: boolean; viewed?: string | null }
export interface Resurface { date: string; due: ResurfaceEntry[]; onThisDay: ResurfaceEntry[]; random: ResurfaceEntry[] }
/** read = will read / watch; done = already read / watched; dismissed = not interested. */
export type Reaction = "read" | "done" | "dismissed";
/** One RSS entry of a curated day. `picked` ones carry `basis` (fit = matches the interests / history, general = worth reading regardless), reason and topics. */
export interface ArticleItem { id: string; title: string; url: string; feed: string; published: string | null; summary: string; picked: boolean; basis?: "fit" | "general"; reason?: string; topics?: string[]; opened_at?: string; reaction?: "saved" | "dismissed"; reacted_at?: string }
export interface ArticleDay { date: string; curated_at: string; feeds: string[]; items: ArticleItem[]; warnings?: string[] }
/** opened = the link was clicked (recorded automatically); saved = sent to the inbox for ingest; dismissed = not interested. */
export type ArticleReaction = "opened" | "saved" | "dismissed";
export interface Job { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; payload: string; result: string | null; log: string; commit: string | null; created_at: string; started_at: string | null; finished_at: string | null }
/** `sources`: JSON array of note paths (the ask skill's 根拠); `sourceNotes`: the same resolved to titles by the API. */
export interface ChatMessage { id: string; role: "user" | "assistant"; text: string; sources: string; sourceNotes?: NoteHead[]; job_id: string | null; created_at: string }
/** One question and its answer (null until the worker's answer lands), tied by the ask job's id. `created_at` is the question's. */
export interface ChatExchange { job_id: string | null; question: ChatMessage; answer: ChatMessage | null; created_at: string }
export interface SearchMatch { path: string; heading: string; snippet: string; spoiler: boolean; via: ("vector" | "keyword")[]; vectorDistance?: number; bm25?: number }
export interface SearchHit { path: string; type: string; title: string; status: string; summary: string; tags: string[]; updated: string; archived: boolean; score: number; confidence: "high" | "low"; matches: SearchMatch[] }
export interface SearchResponse { hits: SearchHit[]; mode: "hybrid" | "vector" | "keyword"; degraded?: string; job?: string; queuedMs?: number | null; workerMs?: number | null }
export interface TypeDef { type: string; folder: string; entity: string; statuses: string[]; fields: string[] }
export interface Home {
  counts: { type: string; c: number }[]; monthlySubscriptions: { currency: string; amount: number }[]; activeSubscriptions: number; // monthly totals per currency, never summed across
  books: Record<string, number>; media: Record<string, number>; projects: NoteSummary[]; recent: NoteSummary[]; jobs: Job[]; resurface: Resurface;
  lint: Record<string, string[] | unknown[]>; head: string; unpushed?: number; pushError?: string | null; // `bronze` is a per-kind summary, not a problem list
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
  /** The current recommendation note (Silver): its body holds the checklist the page parses. */
  suggestions: () => req<{ path: string | null; title?: string; updated: string; markdown: string }>("/suggestions"),
  react: (body: { id: string; reaction: Reaction }) => req<{ ok: boolean; created: string | null; existing: string | null }>("/suggestions/react", { method: "POST", body: JSON.stringify(body) }),
  /** Curated days, newest first; `before` (a date) pages back. `next` is the cursor for the following page. */
  articles: (p: { limit?: number; before?: string } = {}) => req<{ items: ArticleDay[]; next: string | null }>(`/articles?${new URLSearchParams({ ...(p.limit ? { limit: String(p.limit) } : {}), ...(p.before ? { before: p.before } : {}) })}`),
  articleReact: (body: { date: string; id: string; reaction: ArticleReaction }) => req<{ ok: boolean; item: ArticleItem; job: Job | null }>("/articles/react", { method: "POST", body: JSON.stringify(body) }),
  inboxJson: (body: { url?: string; text?: string; title?: string }) => req<{ job: Job }>("/inbox", { method: "POST", body: JSON.stringify(body) }),
  inboxForm: async (form: FormData) => { const r = await fetch("/api/inbox", { method: "POST", body: form }); if (!r.ok) throw new Error(await r.text()); return r.json() as Promise<{ job: Job }>; },
  jobs: () => req<Job[]>("/jobs"),
  job: (id: string) => req<Job>(`/jobs/${id}`),
  /** Long-poll: resolves when the job is done/failed, or after `wait` seconds (≤ 50) with it still running. */
  jobWait: (id: string, wait = 25) => req<Job>(`/jobs/${id}/wait?wait=${wait}`),
  runJob: (kind: string, payload?: unknown) => req<Job>("/jobs", { method: "POST", body: JSON.stringify({ kind, payload }) }),
  /** Newest exchanges first; `before` (a question's `created_at`) pages further back. `next` is the cursor for the following page. */
  chat: (p: { limit?: number; before?: string } = {}) => req<{ items: ChatExchange[]; next: string | null }>(`/chat?${new URLSearchParams({ ...(p.limit ? { limit: String(p.limit) } : {}), ...(p.before ? { before: p.before } : {}) })}`),
  ask: (question: string) => req<{ message: ChatMessage; job: Job }>("/chat", { method: "POST", body: JSON.stringify({ question }) }),
  sync: () => req<{ changed: boolean }>("/sync", { method: "POST" }),
  build: () => req<{ files: string[] }>("/build", { method: "POST" }),
  pushVapid: () => req<{ publicKey: string | null; subscriptions: number }>("/push/vapid"),
  pushSubscribe: (sub: PushSubscriptionJSON) => req<{ ok: boolean }>("/push/subscribe", { method: "POST", body: JSON.stringify(sub) }),
  pushUnsubscribe: (endpoint: string) => req<{ ok: boolean }>("/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  pushTest: () => req<{ sent: number; removed: number; failed: number }>("/push/test", { method: "POST" }),
};
