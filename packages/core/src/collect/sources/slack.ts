/**
 * Slack (a work workspace, usually as the extra account `work`: SLACK_TOKEN__work). A user token (xoxp-, from a
 * Slack app the user creates in the workspace with apps/collector/slack-manifest.yaml) reads, for the window:
 * - mention: messages anywhere that mention me (search.messages `<@me>`, threads included), not my own
 * - dm:      messages in my DMs and group DMs (conversations.history, plus thread replies posted in the window)
 * - channel: every message in the channels named in SLACK_CHANNELS (comma list of names or ids; ones I am a member of)
 * - sent:    my own messages anywhere (search.messages `from:<@me>`): what I worked on / answered
 * - capture: messages I reacted to with SLACK_CAPTURE_EMOJI (default `memo` 📝), whenever they were posted: the
 *            explicit "put this into the knowledge base" gesture. Reactions carry no time, so the cursor keeps the
 *            keys already captured; before the first cursor only messages inside the window count.
 * A message is one item, under the first of capture > mention > dm > channel > sent that matched it.
 * Text is stored with <@U…> / <#C…> / <url|label> resolved to names; the raw API objects are not kept.
 * Slack answers HTTP 200 with { ok: false, error } — `invalid_auth` / `token_revoked` / `account_inactive` count as
 * auth failures (tokens.ts). Customer-built internal apps keep the Tier 3 history limits (≈50/min); 429 Retry-After
 * is honoured by the HTTP client.
 */
import type { Collector, CollectContext } from "../types";
import type { HttpClient } from "../http";

const API = "https://slack.com/api";
const SEARCH_PAGES = 5; // × 100
const HISTORY_PAGES = 5; // × 200 per conversation
const REACTION_PAGES = 3; // × 100, newest reactions first
const SEEN_MAX = 1000;

export type SlackKind = "capture" | "mention" | "dm" | "channel" | "sent";
const PRIORITY: SlackKind[] = ["capture", "mention", "dm", "channel", "sent"];

export interface SlackItem {
  kind: SlackKind;
  channel_id: string;
  /** `#name`, `DM 田中`, or `グループ DM`. */
  channel: string;
  ts: string;
  /** ISO time of ts. */
  at: string;
  /** Set on a thread reply (the parent's ts). */
  thread_ts?: string;
  user?: string;
  who: string;
  text: string;
  files?: string[];
  reply_count?: number;
  permalink: string;
}

interface Msg {
  type?: string; subtype?: string; ts: string; thread_ts?: string; user?: string; bot_id?: string; username?: string;
  text?: string; files?: { name?: string; title?: string }[]; reply_count?: number; latest_reply?: string;
  reactions?: { name: string; users?: string[] }[]; permalink?: string;
  channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
}
interface Conv { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; user?: string; is_archived?: boolean }

/** Message subtypes that are not conversation (joins, topic changes, …). */
const NOISE = /^(channel_|group_)(join|leave|topic|purpose|name|archive|unarchive)|^(bot_add|bot_remove|pinned_item|unpinned_item|reminder_add)$/;

export const tsToIso = (ts: string) => new Date(Math.round(Number(ts) * 1000)).toISOString();
const sec = (d: Date) => String(d.getTime() / 1000);
const inWindow = (ts: string, from: Date, to: Date) => Number(ts) * 1000 >= from.getTime() && Number(ts) * 1000 < to.getTime();
const key = (channel: string, ts: string) => `${channel}:${ts}`;

/** Slack mrkdwn → plain text: users / channels / links / specials resolved. */
export function plainText(text: string, userName: (id: string) => string | undefined): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id: string) => `@${userName(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, (_, id: string, name: string) => `#${name || id}`)
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (_, n: string) => n || "@group")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Permalink without an API call: <team url>archives/<channel>/p<ts without dot>[?thread_ts=…&cid=…]. */
export const permalink = (teamUrl: string, channel: string, ts: string, threadTs?: string) =>
  `${teamUrl.replace(/\/?$/, "/")}archives/${channel}/p${ts.replace(".", "")}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`;

class Slack {
  constructor(private http: HttpClient, private token: string) {}
  async call<T>(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const r = await this.http.json<{ ok: boolean; error?: string; needed?: string } & T>(`${API}/${method}?${q}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`Slack ${method}: ${r.error}${r.needed ? ` (needs scope ${r.needed})` : ""}`);
    return r;
  }
}

export const slack: Collector = {
  id: "slack",
  label: "Slack",
  lookbackDays: 7,
  configured: (env) => (env.SLACK_TOKEN ? true : "missing SLACK_TOKEN"),
  async collect({ env, http, from, to, cursor, log }: CollectContext) {
    const api = new Slack(http, env.SLACK_TOKEN!);
    const me = await api.call<{ user_id: string; user: string; team: string; url: string }>("auth.test");
    const emoji = (env.SLACK_CAPTURE_EMOJI || "memo").replace(/:/g, "");
    const watch = (env.SLACK_CHANNELS ?? "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    const seenBefore: string[] = cursor ? (JSON.parse(cursor) as { seen?: string[] }).seen ?? [] : [];

    // names
    const users = new Map<string, string>();
    const userName = (id: string) => users.get(id);
    async function loadUser(id: string) {
      if (users.has(id)) return;
      try {
        const u = await api.call<{ user: { name: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: id });
        users.set(id, u.user.profile?.display_name || u.user.profile?.real_name || u.user.real_name || u.user.name);
      } catch (e) {
        users.set(id, id);
        log.warn(`slack: users.info ${id}: ${(e as Error).message}`);
      }
    }

    // conversations I am a member of
    const convs: Conv[] = [];
    for (let next: string | undefined, page = 0; page < 20; page++) {
      const r = await api.call<{ channels: Conv[]; response_metadata?: { next_cursor?: string } }>("users.conversations", {
        types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 200, cursor: next,
      });
      convs.push(...r.channels);
      next = r.response_metadata?.next_cursor || undefined;
      if (!next) break;
    }
    const convById = new Map(convs.map((c) => [c.id, c]));
    const watched = convs.filter((c) => !c.is_im && !c.is_mpim && (watch.includes(c.id) || (c.name && watch.includes(c.name))));
    const missing = watch.filter((w) => !watched.some((c) => c.id === w || c.name === w));
    if (missing.length) log.warn(`slack: SLACK_CHANNELS not found among my channels: ${missing.join(", ")}`);

    const found = new Map<string, { kind: SlackKind; channel: string; m: Msg }>();
    const add = (kind: SlackKind, channel: string, m: Msg) => {
      if (m.subtype && NOISE.test(m.subtype)) return;
      const k = key(channel, m.ts);
      const prev = found.get(k);
      if (!prev || PRIORITY.indexOf(kind) < PRIORITY.indexOf(prev.kind)) found.set(k, { kind, channel, m: prev ? { ...prev.m, ...m } : m });
    };

    // search: mentions of me and my own messages (threads included). Newest first; stop below the window.
    async function search(query: string, kind: SlackKind, keep: (m: Msg) => boolean) {
      const day = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10); // after: is exclusive
      for (let page = 1; page <= SEARCH_PAGES; page++) {
        const r = await api.call<{ messages: { matches: Msg[]; paging?: { pages: number } } }>("search.messages", {
          query: `${query} after:${day}`, sort: "timestamp", sort_dir: "desc", count: 100, page,
        });
        const matches = r.messages.matches ?? [];
        for (const m of matches) if (m.channel?.id && inWindow(m.ts, from, to) && keep(m)) add(kind, m.channel.id, m);
        if (!matches.length || page >= (r.messages.paging?.pages ?? 1) || Number(matches.at(-1)!.ts) * 1000 < from.getTime()) break;
      }
    }
    await search(`<@${me.user_id}>`, "mention", (m) => m.user !== me.user_id && (m.text ?? "").includes(`<@${me.user_id}>`));
    await search(`from:<@${me.user_id}>`, "sent", (m) => m.user === me.user_id);

    // history: DMs, group DMs and the watched channels, with the thread replies posted in the window
    async function history(c: Conv, kind: SlackKind) {
      for (let next: string | undefined, page = 0; page < HISTORY_PAGES; page++) {
        const r = await api.call<{ messages: Msg[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>("conversations.history", {
          channel: c.id, oldest: sec(from), latest: sec(to), limit: 200, cursor: next,
        });
        for (const m of r.messages) {
          add(kind, c.id, m);
          if (m.reply_count && m.latest_reply && Number(m.latest_reply) * 1000 >= from.getTime()) await replies(c, kind, m.ts);
        }
        next = r.response_metadata?.next_cursor || undefined;
        if (!r.has_more || !next) break;
      }
    }
    async function replies(c: Conv, kind: SlackKind, thread: string) {
      const r = await api.call<{ messages: Msg[] }>("conversations.replies", { channel: c.id, ts: thread, oldest: sec(from), latest: sec(to), limit: 200 });
      for (const m of r.messages) if (m.ts !== thread && inWindow(m.ts, from, to)) add(kind, c.id, m);
    }
    for (const c of convs.filter((c) => c.is_im || c.is_mpim)) await history(c, "dm");
    for (const c of watched) await history(c, "channel");

    // captures: my reaction with the capture emoji, whenever the message was posted
    const seen = new Set(seenBefore);
    const captured: string[] = [];
    for (let page = 1; page <= REACTION_PAGES; page++) {
      const r = await api.call<{ items: { type: string; channel?: string; message?: Msg }[]; paging?: { pages: number } }>("reactions.list", {
        user: me.user_id, full: true, count: 100, page,
      });
      for (const it of r.items) {
        const m = it.message;
        if (it.type !== "message" || !it.channel || !m) continue;
        if (!m.reactions?.some((x) => x.name === emoji && x.users?.includes(me.user_id))) continue;
        const k = key(it.channel, m.ts);
        if (seen.has(k) || (!cursor && !inWindow(m.ts, from, to))) continue;
        seen.add(k);
        captured.push(k);
        add("capture", it.channel, m);
      }
      if (page >= (r.paging?.pages ?? 1)) break;
    }

    // resolve names, render
    const ids = new Set<string>();
    for (const { m } of found.values()) {
      if (m.user) ids.add(m.user);
      for (const [, id] of (m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(id!);
    }
    for (const c of convs) if (c.is_im && c.user) ids.add(c.user);
    for (const id of ids) await loadUser(id);
    const channelLabel = (id: string, m: Msg) => {
      const c = convById.get(id);
      if (c?.is_im || m.channel?.is_im) return `DM ${userName(c?.user ?? "") ?? ""}`.trim();
      if (c?.is_mpim || m.channel?.is_mpim) return "グループ DM";
      return `#${c?.name ?? m.channel?.name ?? id}`;
    };

    const items: SlackItem[] = [...found.values()]
      .sort((a, b) => Number(a.m.ts) - Number(b.m.ts))
      .map(({ kind, channel, m }) => {
        const thread = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined;
        const files = (m.files ?? []).map((f) => f.title || f.name || "").filter(Boolean);
        return {
          kind, channel_id: channel, channel: channelLabel(channel, m), ts: m.ts, at: tsToIso(m.ts),
          ...(thread ? { thread_ts: thread } : {}),
          ...(m.user ? { user: m.user } : {}),
          who: m.user === me.user_id ? "自分" : (m.user && userName(m.user)) || m.username || (m.bot_id ? "bot" : "?"),
          text: plainText(m.text ?? "", userName),
          ...(files.length ? { files } : {}),
          ...(m.reply_count ? { reply_count: m.reply_count } : {}),
          permalink: m.permalink ?? permalink(me.url, channel, m.ts, thread),
        };
      });
    const counts = Object.fromEntries(PRIORITY.map((k) => [k, items.filter((i) => i.kind === k).length]));
    return {
      items,
      meta: { team: me.team, user: me.user, capture_emoji: emoji, watched: watched.map((c) => c.name ?? c.id), counts },
      cursor: JSON.stringify({ seen: [...seenBefore, ...captured].slice(-SEEN_MAX) }),
    };
  },
  digest(item) {
    const it = item as SlackItem;
    const local = new Date(it.at).toLocaleString("sv-SE").slice(0, 16);
    const text = it.text.replace(/\s+/g, " ").trim();
    const clip = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    const extra = [it.thread_ts ? "スレッド返信" : "", it.reply_count ? `返信 ${it.reply_count}` : "", it.files?.length ? `添付 ${it.files.join(", ")}` : ""].filter(Boolean).join("・");
    return `${local} [${it.kind}] ${it.channel} ${it.who}: ${clip}${extra ? `（${extra}）` : ""} ${it.permalink}`;
  },
};
