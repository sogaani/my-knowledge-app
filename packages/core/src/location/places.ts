/**
 * Places API (New) Place Details for placeIds, behind a local SQLite cache that forgets entries after at most 30 days
 * (Google Maps Platform terms: only place IDs may be stored indefinitely; lat/lng for up to 30 days, so coordinates
 * come from the Timeline export instead of the API). Only displayName, primaryType and googleMapsUri are requested
 * (all in the same Place Details tier).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, mapLimit, type HttpClient } from "../collect/http";

const API = "https://places.googleapis.com/v1/places";
const DAY = 86_400_000;
export const MAX_CACHE_DAYS = 30;

export interface PlaceInfo {
  placeId: string;
  name: string | null;
  primaryType: string | null;
  /** link to the place on Google Maps */
  mapsUri: string | null;
  /** not_found: the placeId no longer resolves (Timeline ids can go stale) */
  status: "ok" | "not_found";
}

export class PlacesCache {
  private db: Database;
  readonly ttlMs: number;
  constructor(path: string, ttlDays = MAX_CACHE_DAYS) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("CREATE TABLE IF NOT EXISTS places (place_id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, maps_uri TEXT, status TEXT NOT NULL, fetched_at INTEGER NOT NULL)");
    // caches created before googleMapsUri was requested
    const cols = this.db.query("PRAGMA table_info(places)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "maps_uri")) this.db.run("ALTER TABLE places ADD COLUMN maps_uri TEXT");
    this.ttlMs = Math.min(Math.max(ttlDays, 0), MAX_CACHE_DAYS) * DAY;
  }
  get(placeId: string, now = Date.now()): PlaceInfo | undefined {
    const r = this.db.query("SELECT display_name, primary_type, maps_uri, status, fetched_at FROM places WHERE place_id = ?").get(placeId) as
      { display_name: string | null; primary_type: string | null; maps_uri: string | null; status: "ok" | "not_found"; fetched_at: number } | null;
    if (!r || now - r.fetched_at >= this.ttlMs) return undefined;
    if (r.status === "ok" && !r.maps_uri) return undefined; // cached before googleMapsUri was requested: refetch
    return { placeId, name: r.display_name, primaryType: r.primary_type, mapsUri: r.maps_uri, status: r.status };
  }
  put(p: PlaceInfo, now = Date.now()) {
    this.db.run("INSERT OR REPLACE INTO places (place_id, display_name, primary_type, maps_uri, status, fetched_at) VALUES (?, ?, ?, ?, ?, ?)", [p.placeId, p.name, p.primaryType, p.mapsUri, p.status, now]);
  }
  /** Delete entries older than the TTL. Returns how many were removed. */
  purge(now = Date.now()): number {
    return this.db.run("DELETE FROM places WHERE fetched_at <= ?", [now - this.ttlMs]).changes;
  }
  close() { this.db.close(); }
}

/** One Place Details call. A stale/unknown id → not_found; anything else (bad key, quota after retries) throws. */
export async function fetchPlace(http: HttpClient, apiKey: string, placeId: string, languageCode = "ja"): Promise<PlaceInfo> {
  try {
    const r = await http.json<{ id?: string; displayName?: { text?: string }; primaryType?: string; googleMapsUri?: string }>(
      `${API}/${encodeURIComponent(placeId)}?languageCode=${languageCode}`,
      { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,displayName,primaryType,googleMapsUri" } },
    );
    return { placeId, name: r.displayName?.text ?? null, primaryType: r.primaryType ?? null, mapsUri: r.googleMapsUri ?? null, status: "ok" };
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || (e.status === 400 && /NOT_FOUND|not found|Not a valid Place ID/i.test(e.body)))) {
      return { placeId, name: null, primaryType: null, mapsUri: null, status: "not_found" };
    }
    throw e;
  }
}

export interface LookupResult {
  places: Map<string, PlaceInfo>;
  cached: number;
  fetched: number;
  /** ids left without details because maxLookups was reached; rerun to fill them */
  deferred: string[];
}

/** Details for each id: cache first, then at most `maxLookups` API calls (5 in parallel). */
export async function lookupPlaces(ids: string[], o: { http: HttpClient; apiKey: string; cache: PlacesCache; maxLookups: number; now?: number }): Promise<LookupResult> {
  const now = o.now ?? Date.now();
  o.cache.purge(now);
  const places = new Map<string, PlaceInfo>();
  const missing: string[] = [];
  let cached = 0;
  for (const id of new Set(ids)) {
    const hit = o.cache.get(id, now);
    if (hit) { places.set(id, hit); cached++; } else missing.push(id);
  }
  const todo = missing.slice(0, Math.max(0, o.maxLookups));
  const fetched = await mapLimit(todo, 5, (id) => fetchPlace(o.http, o.apiKey, id));
  for (const p of fetched) { o.cache.put(p, now); places.set(p.placeId, p); }
  return { places, cached, fetched: fetched.length, deferred: missing.slice(todo.length) };
}
