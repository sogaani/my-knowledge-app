/**
 * YouTube: liked videos (videos.list?myRating=like) and, if YOUTUBE_PLAYLIST_IDS is set, those playlists.
 * The API gives no "liked at" time, so new likes are found by diffing against the ids seen last run (cursor).
 */
import { googleJson } from "../google";
import type { Collector } from "../types";

const API = "https://www.googleapis.com/youtube/v3";
const SEEN_MAX = 2000; // ids kept in the cursor

interface Video { id: string; snippet: { title: string; channelTitle: string; publishedAt: string; description?: string; tags?: string[]; categoryId?: string }; contentDetails?: { duration?: string } }
interface PlaylistItem { snippet: { title: string; videoOwnerChannelTitle?: string; publishedAt: string; resourceId: { videoId: string }; playlistId: string } }
type Item = { via: "like"; video: Video } | { via: "playlist"; playlistId: string; item: PlaylistItem };

const keyOf = (it: Item) => (it.via === "like" ? `like:${it.video.id}` : `pl:${it.playlistId}:${it.item.snippet.resourceId.videoId}`);

export const youtube: Collector = {
  id: "youtube",
  label: "YouTube",
  lookbackDays: 7,
  configured: (env) => (env.GOOGLE_REFRESH_TOKEN ? true : "missing GOOGLE_REFRESH_TOKEN (run: bun run collect auth google)"),
  async collect({ env, http, google, cursor }) {
    const seen = new Set<string>(cursor ? (JSON.parse(cursor) as string[]) : []);
    const firstRun = !cursor;
    const all: Item[] = [];

    // newest likes come first: stop paging once a whole page is already known
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ myRating: "like", part: "snippet,contentDetails", maxResults: "50", ...(pageToken ? { pageToken } : {}) });
      const r = await googleJson<{ items: Video[]; nextPageToken?: string }>(http, google, `${API}/videos?${q}`);
      const items = r.items.map((video) => ({ via: "like" as const, video }));
      all.push(...items);
      pageToken = r.nextPageToken;
      if (firstRun || !pageToken || items.every((it) => seen.has(keyOf(it)))) break; // first run: newest 50 only
    }
    for (const playlistId of (env.YOUTUBE_PLAYLIST_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      let token: string | undefined;
      do {
        const q = new URLSearchParams({ playlistId, part: "snippet", maxResults: "50", ...(token ? { pageToken: token } : {}) });
        const r = await googleJson<{ items: PlaylistItem[]; nextPageToken?: string }>(http, google, `${API}/playlistItems?${q}`);
        all.push(...r.items.map((item) => ({ via: "playlist" as const, playlistId, item })));
        token = r.nextPageToken;
      } while (token);
    }

    const fresh = all.filter((it) => !seen.has(keyOf(it)));
    const nextSeen = [...new Set([...all.map(keyOf), ...seen])].slice(0, SEEN_MAX);
    return { items: fresh, cursor: JSON.stringify(nextSeen) };
  },
  digest(item) {
    const it = item as Item;
    if (it.via === "like") return `高評価 ${it.video.snippet.channelTitle} 「${it.video.snippet.title}」 https://youtu.be/${it.video.id}`;
    return `再生リスト ${it.item.snippet.videoOwnerChannelTitle ?? ""} 「${it.item.snippet.title}」 https://youtu.be/${it.item.snippet.resourceId.videoId}`;
  },
};
