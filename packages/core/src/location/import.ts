/**
 * `kb location import <bronze-id>`: a Google Maps Timeline export in Bronze → monthly `location_log` notes
 * (200_silver/211_location, git-crypt). Place names / types come from the Places API (cached ≤ 30 days, places.ts);
 * coordinates stay those of the export. Exports repeat the whole history, so each rebuilt month is assembled from every
 * Timeline export in Bronze (dedup by start + placeId) and only some months are rebuilt per run (see pickMonths).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "../config";
import { bronzeDir, markProcessed, readMeta, walkBronze, type BronzeMeta } from "../bronze";
import { createNote } from "../create";
import { parseNote, stringifyNote } from "../frontmatter";
import { runQuery } from "../query";
import type { SchemaRegistry } from "../schema";
import { createHttp, type HttpClient } from "../collect/http";
import { looksLikeTimeline, parseTimeline, type Visit } from "./parse";
import { lookupPlaces, PlacesCache, MAX_CACHE_DAYS, type PlaceInfo } from "./places";

const BEGIN = "<!-- kb:location:start -->";
const END = "<!-- kb:location:end -->";
export const DEFAULT_MAX_LOOKUPS = 300;
/** Visits worth a look by the ingest agent (they may belong in a media / learning / project / person note). */
export const NOTABLE_TYPES = new Set([
  "museum", "art_museum", "art_gallery", "history_museum", "movie_theater", "performing_arts_theater", "concert_hall", "stadium",
  "gym", "fitness_center", "bouldering_gym", "climbing_gym", "sports_club", "book_store", "library", "university", "tourist_attraction",
  "amusement_park", "zoo", "aquarium", "hospital", "dentist", "airport", "lodging", "hotel",
]);

/**
 * Wall-clock date / time where the visit happened: the on-device exports carry the local offset ("…T10:00:00.000+09:00"),
 * so a trip abroad shows local times. Only offset-less / UTC stamps (old Takeout "…Z") fall back to this machine's zone.
 */
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/;
export const localDate = (iso: string) => WALL.exec(iso)?.[1] ?? new Date(iso).toLocaleDateString("sv-SE");
const hhmm = (iso: string) => WALL.exec(iso)?.[2] ?? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const duration = (a: string, b: string) => {
  const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The Timeline JSON file of a Bronze item, or null when it has none. */
function timelineFile(cfg: KbConfig, meta: BronzeMeta): string | null {
  for (const f of meta.files.filter((x) => /\.json$/i.test(x))) {
    const p = join(bronzeDir(cfg, meta.id), f);
    if (looksLikeTimeline(readFileSync(p, "utf8"))) return p;
  }
  return null;
}

export interface LocationImportOpts {
  maxLookups?: number;
  /** rebuild every month of the export, not just new / recent / incomplete ones */
  all?: boolean;
  apiKey?: string;
  http?: HttpClient;
  now?: Date;
  cachePath?: string;
}
export interface LocationRow { visit: Visit; place?: PlaceInfo }
export interface LocationImportResult {
  bronzeId: string;
  months: { path: string; created: boolean; visits: number; unresolved: number }[];
  skippedMonths: string[];
  notable: LocationRow[];
  fetched: number;
  cached: number;
  deferred: number;
}

export function placesApiKey(cfg: KbConfig, env = process.env): string | undefined {
  return env.GOOGLE_MAPS_API_KEY || cfg.local.places?.api_key || undefined;
}

/**
 * Months to rebuild: a full export spans years, and rebuilding all of them means a Places lookup for every place ever.
 * Rebuild months with no note yet, the two most recent months (the export keeps growing there), and months whose note
 * still has unresolved places (a previous run hit maxLookups). `--all` rebuilds everything.
 */
export function pickMonths(exportMonths: string[], notes: Map<string, { unresolved: number }>, now: Date, all = false): { rebuild: string[]; skip: string[] } {
  const recent = new Set([0, 1].map((i) => new Date(now.getFullYear(), now.getMonth() - i, 1).toLocaleDateString("sv-SE").slice(0, 7)));
  const rebuild: string[] = [], skip: string[] = [];
  for (const m of [...new Set(exportMonths)].sort()) {
    const n = notes.get(m);
    (all || !n || n.unresolved > 0 || recent.has(m) ? rebuild : skip).push(m);
  }
  return { rebuild, skip };
}

export function renderLocationTable(rows: LocationRow[]): string {
  const name = (r: LocationRow) => (!r.place ? "（未取得）" : r.place.status === "not_found" ? "（不明な場所）" : r.place.name ?? "（名称なし）");
  return [
    BEGIN,
    "_Google マップのタイムラインから自動生成（`kb location import` が書き換える区間。メモは下の `## メモ` に書く）_", "",
    "| 日付 | 時間 | 場所 | ジャンル | 滞在 |",
    "|---|---|---|---|---|",
    ...rows.map(({ visit: v, place: p }) => {
      const sameDay = localDate(v.start) === localDate(v.end);
      return `| ${localDate(v.start)} | ${hhmm(v.start)}–${sameDay ? "" : `${localDate(v.end).slice(5)} `}${hhmm(v.end)} | ${cell(name({ visit: v, place: p }))} | ${p?.primaryType ?? v.semanticType?.toLowerCase().replace(/^type_/, "") ?? ""} | ${duration(v.start, v.end)} |`;
    }),
    END,
  ].join("\n");
}

export async function importLocation(cfg: KbConfig, reg: SchemaRegistry, db: Database, bronzeId: string, o: LocationImportOpts = {}): Promise<LocationImportResult> {
  const meta = readMeta(cfg, bronzeId);
  if (!meta) throw new Error(`no Bronze item ${bronzeId}`);
  const file = timelineFile(cfg, meta);
  if (!file) throw new Error(`${bronzeId} has no Google Maps Timeline export (Timeline.json / Semantic Location History)`);
  if (!reg.get("location_log")) throw new Error("schema location_log.json missing");
  const apiKey = o.apiKey ?? placesApiKey(cfg);
  if (!apiKey) throw new Error("Places API key missing: set [places] api_key in 900_system/config.local.toml (or GOOGLE_MAPS_API_KEY)");
  const now = o.now ?? new Date();

  const own = parseTimeline(JSON.parse(readFileSync(file, "utf8")));
  const existing = new Map<string, { path: string; unresolved: number }>();
  for (const n of runQuery(db, { filters: [{ field: "type", op: "=", value: "location_log" }], limit: 10000 })) {
    existing.set(String(n.fm.month ?? ""), { path: n.path, unresolved: Number(n.fm.unresolved ?? 0) });
  }
  const { rebuild, skip } = pickMonths(own.map((v) => localDate(v.start).slice(0, 7)), existing, now, o.all);

  // every Timeline export in Bronze (oldest capture first, so a later export wins on the same visit)
  const exports = [...walkBronze(cfg)]
    .filter((m) => m.kind === "file" && m.files.some((f) => /\.json$/i.test(f)))
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const byMonth = new Map<string, Map<string, Visit>>(rebuild.map((m) => [m, new Map()]));
  const contributing = new Map<string, Set<string>>(rebuild.map((m) => [m, new Set()]));
  for (const m of exports) {
    const f = m.id === bronzeId ? file : timelineFile(cfg, m);
    if (!f) continue;
    const visits = m.id === bronzeId ? own : parseTimeline(JSON.parse(readFileSync(f, "utf8")));
    for (const v of visits) {
      const month = byMonth.get(localDate(v.start).slice(0, 7));
      if (!month) continue;
      month.set(`${v.start}|${v.placeId}`, v);
      contributing.get(localDate(v.start).slice(0, 7))!.add(m.id);
    }
  }

  const ids = [...byMonth.values()].flatMap((m) => [...m.values()].map((v) => v.placeId));
  const ttl = Number(cfg.local.places?.cache_ttl_days ?? MAX_CACHE_DAYS);
  const cache = new PlacesCache(o.cachePath ?? join(cfg.cache, "places.sqlite"), ttl);
  let lookup;
  try {
    lookup = await lookupPlaces(ids, {
      http: o.http ?? createHttp(), apiKey, cache, now: now.getTime(),
      maxLookups: o.maxLookups ?? Number(cfg.local.places?.max_lookups ?? DEFAULT_MAX_LOOKUPS),
    });
  } finally {
    cache.close();
  }

  const result: LocationImportResult = { bronzeId, months: [], skippedMonths: skip, notable: [], fetched: lookup.fetched, cached: lookup.cached, deferred: lookup.deferred.length };
  for (const month of rebuild) {
    const rows: LocationRow[] = [...byMonth.get(month)!.values()]
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .map((visit) => ({ visit, place: lookup.places.get(visit.placeId) }));
    if (!rows.length) continue;
    const unresolved = rows.filter((r) => !r.place).length;
    const counts = new Map<string, number>();
    for (const r of rows) if (r.place?.status === "ok" && r.place.name) counts.set(r.place.name, (counts.get(r.place.name) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`);

    let rel = existing.get(month)?.path, created = false;
    if (!rel || !existsSync(join(cfg.root, rel))) {
      rel = createNote(cfg, reg, db, { type: "location_log", title: month, set: { month } });
      created = true;
    }
    const abs = join(cfg.root, rel);
    const { fm, body } = parseNote(readFileSync(abs, "utf8"));
    const block = renderLocationTable(rows);
    const b = body.indexOf(BEGIN), e = body.indexOf(END);
    let newBody: string;
    if (b !== -1 && e > b) newBody = body.slice(0, b) + block + body.slice(e + END.length);
    else {
      const h = /^## 日別\s*\n/m.exec(body) ?? /^# .*\n/m.exec(body);
      const at = h ? h.index + h[0].length : 0;
      newBody = body.slice(0, at) + "\n" + block + "\n" + body.slice(at);
    }
    Object.assign(fm, {
      month, visits: rows.length, places: new Set(rows.map((r) => r.visit.placeId)).size, unresolved, top_places: top,
      summary: `${month.replace("-", "年").replace(/^(\d+年)0?/, "$1")}月の滞在記録（${rows.length} 件・${new Set(rows.map((r) => r.visit.placeId)).size} か所）`,
      updated: today(),
    });
    fm.sources = [...new Set([...(Array.isArray(fm.sources) ? fm.sources.map(String) : []), ...contributing.get(month)!])];
    writeFileSync(abs, stringifyNote(fm, newBody));
    markProcessed(cfg, bronzeId, [rel]);
    result.months.push({ path: rel, created, visits: rows.length, unresolved });
    result.notable.push(...rows.filter((r) => r.place?.primaryType && NOTABLE_TYPES.has(r.place.primaryType)));
  }
  if (!result.months.length) markProcessed(cfg, bronzeId, ["-"]);
  return result;
}
