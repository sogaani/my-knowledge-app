import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttp, HttpError } from "../collect/http";
import { loadConfig } from "../config";
import { SchemaRegistry } from "../schema";
import { indexNotes, openDb } from "../db";
import { ingestFile, readMeta } from "../bronze";
import { parseNote } from "../frontmatter";
import { NotATimelineError, parseLatLng, parseTimeline } from "./parse";
import { fetchPlace, lookupPlaces, PlacesCache } from "./places";
import { importLocation, pickMonths } from "./import";

// times at 03:00Z–12:00Z fall on the same calendar date in UTC and in JST
const android = {
  semanticSegments: [
    { startTime: "2026-09-30T10:00:00.000+09:00", endTime: "2026-09-30T12:30:00.000+09:00", visit: { hierarchyLevel: 0, probability: 0.9, topCandidate: { placeId: "P_gym", semanticType: "UNKNOWN", probability: 0.8, placeLocation: { latLng: "35.6812°, 139.7671°" } } } },
    { startTime: "2026-09-30T12:30:00.000+09:00", endTime: "2026-09-30T13:00:00.000+09:00", timelinePath: [{ point: "35.6°, 139.7°", time: "2026-09-30T12:40:00.000+09:00" }] },
    { startTime: "2026-10-01T13:00:00.000+09:00", endTime: "2026-10-01T15:00:00.000+09:00", visit: { topCandidate: { placeId: "P_museum", semanticType: "UNKNOWN", placeLocation: { latLng: "35.71°, 139.77°" } } } },
    { startTime: "2026-10-02T13:00:00.000+09:00", endTime: "2026-10-02T14:00:00.000+09:00", visit: { topCandidate: { semanticType: "HOME" } } }, // no placeId
  ],
  rawSignals: [], userLocationProfile: {},
};
const ios = [
  { startTime: "2026-10-03T11:00:00.000+09:00", endTime: "2026-10-03T12:00:00.000+09:00", visit: { probability: "0.9", topCandidate: { placeID: "P_cafe", semanticType: "Unknown", placeLocation: "geo:35.660000,139.700000" } } },
  { startTime: "2026-10-03T12:00:00.000+09:00", endTime: "2026-10-03T12:30:00.000+09:00", activity: { topCandidate: { type: "walking" } } },
];
const takeout = {
  timelineObjects: [
    { activitySegment: { duration: { startTimestamp: "2024-03-01T00:00:00Z" } } },
    { placeVisit: { location: { placeId: "P_old", latitudeE7: 356812000, longitudeE7: 1397671000, semanticType: "TYPE_CAFE" }, duration: { startTimestampMs: String(Date.parse("2024-03-02T03:00:00Z")), endTimestampMs: String(Date.parse("2024-03-02T04:00:00Z")) } } },
  ],
};

describe("parseTimeline", () => {
  test("android on-device export: visits only, placeId required, degree strings", () => {
    expect(parseTimeline(android)).toEqual([
      { start: "2026-09-30T10:00:00.000+09:00", end: "2026-09-30T12:30:00.000+09:00", placeId: "P_gym", lat: 35.6812, lng: 139.7671, semanticType: "UNKNOWN", source: "android" },
      { start: "2026-10-01T13:00:00.000+09:00", end: "2026-10-01T15:00:00.000+09:00", placeId: "P_museum", lat: 35.71, lng: 139.77, semanticType: "UNKNOWN", source: "android" },
    ]);
  });
  test("iOS export (placeID, geo: URI) and old Takeout (placeVisit, E7, *TimestampMs)", () => {
    expect(parseTimeline(ios)).toEqual([{ start: "2026-10-03T11:00:00.000+09:00", end: "2026-10-03T12:00:00.000+09:00", placeId: "P_cafe", lat: 35.66, lng: 139.7, semanticType: "Unknown", source: "ios" }]);
    expect(parseTimeline(takeout)).toEqual([{ start: "2024-03-02T03:00:00.000Z", end: "2024-03-02T04:00:00.000Z", placeId: "P_old", lat: 35.6812, lng: 139.7671, semanticType: "TYPE_CAFE", source: "takeout" }]);
  });
  test("anything else is rejected", () => {
    expect(() => parseTimeline({ hello: 1 })).toThrow(NotATimelineError);
    expect(() => parseTimeline([1, 2])).toThrow(NotATimelineError);
    expect(parseLatLng("not a point")).toEqual([null, null]);
  });
});

type Call = { url: string; init?: RequestInit };
function placesApi(names: Record<string, [string, string] | 404>, opts: { status429First?: boolean } = {}) {
  const calls: Call[] = [];
  let first429 = !!opts.status429First;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (first429) { first429 = false; return new Response("{}", { status: 429, headers: { "retry-after": "1" } }); }
    const id = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const v = names[id];
    if (v === 404 || !v) return new Response('{"error":{"code":404,"status":"NOT_FOUND"}}', { status: 404 });
    return new Response(JSON.stringify({ id, displayName: { text: v[0], languageCode: "ja" }, primaryType: v[1] }));
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  return { http: createHttp({ fetchImpl, sleep: async (ms) => { waits.push(ms); } }), calls, waits };
}

describe("places", () => {
  test("fetch: field mask + key header; 404 is not_found; a bad key throws", async () => {
    const { http, calls } = placesApi({ P1: ["ジム", "gym"] });
    expect(await fetchPlace(http, "KEY", "P1")).toEqual({ placeId: "P1", name: "ジム", primaryType: "gym", status: "ok" });
    const h = new Headers(calls[0]!.init!.headers);
    expect(h.get("X-Goog-FieldMask")).toBe("id,displayName,primaryType");
    expect(h.get("X-Goog-Api-Key")).toBe("KEY");
    expect(calls[0]!.url).toContain("languageCode=ja");
    expect((await fetchPlace(http, "KEY", "gone")).status).toBe("not_found");
    const bad = createHttp({ fetchImpl: (async () => new Response('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}', { status: 400 })) as unknown as typeof fetch });
    await expect(fetchPlace(bad, "BAD", "P1")).rejects.toBeInstanceOf(HttpError);
  });

  test("cache: hits within 30 days skip the API, older entries are refetched and purged", async () => {
    const cache = new PlacesCache(":memory:", 30);
    const day = 86_400_000, t0 = Date.parse("2026-10-01T00:00:00Z");
    const a = placesApi({ P1: ["ジム", "gym"], P2: ["美術館", "art_museum"] });
    const r1 = await lookupPlaces(["P1", "P2", "P1"], { http: a.http, apiKey: "K", cache, maxLookups: 10, now: t0 });
    expect([r1.fetched, r1.cached, a.calls.length]).toEqual([2, 0, 2]);
    const r2 = await lookupPlaces(["P1", "P2"], { http: a.http, apiKey: "K", cache, maxLookups: 10, now: t0 + 29 * day });
    expect([r2.fetched, r2.cached, a.calls.length]).toEqual([0, 2, 2]);
    expect(cache.purge(t0 + 31 * day)).toBe(2); // gone after 30 days
    const r3 = await lookupPlaces(["P1"], { http: a.http, apiKey: "K", cache, maxLookups: 10, now: t0 + 31 * day });
    expect(r3.fetched).toBe(1);
    expect(new PlacesCache(":memory:", 365).ttlMs).toBe(30 * day); // TTL is capped at 30 days
  });

  test("maxLookups defers the rest; 429 is retried after Retry-After", async () => {
    const cache = new PlacesCache(":memory:");
    const a = placesApi({ P1: ["A", "cafe"], P2: ["B", "cafe"], P3: ["C", "cafe"] }, { status429First: true });
    const r = await lookupPlaces(["P1", "P2", "P3"], { http: a.http, apiKey: "K", cache, maxLookups: 2 });
    expect(r.fetched).toBe(2);
    expect(r.deferred).toEqual(["P3"]);
    expect(a.waits).toEqual([1000]);
  });
});

describe("pickMonths", () => {
  const now = new Date(2026, 9, 12);
  test("new, recent and incomplete months are rebuilt; settled ones are skipped unless --all", () => {
    const notes = new Map([["2026-01", { unresolved: 0 }], ["2026-02", { unresolved: 3 }], ["2026-09", { unresolved: 0 }]]);
    const r = pickMonths(["2025-12", "2026-01", "2026-02", "2026-09", "2026-10"], notes, now);
    expect(r).toEqual({ rebuild: ["2025-12", "2026-02", "2026-09", "2026-10"], skip: ["2026-01"] });
    expect(pickMonths(["2026-01"], notes, now, true).rebuild).toEqual(["2026-01"]);
  });
});

function kb() {
  const root = mkdtempSync(join(tmpdir(), "kb-location-"));
  const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  w("AGENTS.md", "#");
  w("900_system/schemas/_common.json", JSON.stringify({ $id: "kb:common", type: "object", required: ["type", "title", "status", "created", "updated"] }));
  w("900_system/schemas/location_log.json", JSON.stringify({
    $id: "kb:location_log", "x-kb": { folder: "200_silver/211_location", entity: "file" }, allOf: [{ $ref: "kb:common" }],
    properties: { type: { const: "location_log" }, status: { enum: ["open", "closed"] }, month: { type: "string" } },
  }));
  w("800_templates/location_log.md", "---\ntype: location_log\ntitle: \"{{title}}\"\nstatus: open\ntags: []\ncreated: {{today}}\nupdated: {{today}}\nsources: []\nrelated: []\nsummary: \"\"\nmonth: \"\"\n---\n\n# {{title}} 滞在記録\n\n## 日別\n\n## メモ\n");
  mkdirSync(join(root, "200_silver", "211_location"), { recursive: true });
  mkdirSync(join(root, "000_inbox"), { recursive: true });
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  return { cfg, reg: new SchemaRegistry(cfg) };
}

describe("importLocation", () => {
  test("monthly notes; a capped run leaves 未取得 that a rerun fills; notable visits; memo kept", async () => {
    const { cfg, reg } = kb();
    const p = join(cfg.inbox, "Timeline.json");
    writeFileSync(p, JSON.stringify(android));
    const bronze = ingestFile(cfg, p);
    expect(bronze.kind).toBe("file");
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const api = placesApi({ P_gym: ["ボルダリングジム X", "bouldering_gym"], P_museum: ["国立西洋美術館", "art_museum"] });
    const opts = { http: api.http, apiKey: "K", now: new Date(2026, 9, 12), cachePath: join(cfg.cache, "places.sqlite") };

    const r1 = await importLocation(cfg, reg, db, bronze.id, { ...opts, maxLookups: 1 });
    expect(r1.months.map((m) => [m.path.split("/").pop(), m.created, m.visits, m.unresolved])).toEqual([["2026-09.md", true, 1, 0], ["2026-10.md", true, 1, 1]]);
    expect(r1.deferred).toBe(1);
    const oct = join(cfg.root, r1.months[1]!.path);
    expect(readFileSync(oct, "utf8")).toContain("（未取得）");
    writeFileSync(oct, readFileSync(oct, "utf8").replace("## メモ\n", "## メモ\n\n- 企画展を見た\n"));

    indexNotes(cfg, db);
    const r2 = await importLocation(cfg, reg, db, bronze.id, opts);
    expect([r2.fetched, r2.cached, r2.deferred]).toEqual([1, 1, 0]);
    const { fm, body } = parseNote(readFileSync(oct, "utf8"));
    expect(body).toContain("| 2026-10-01 | 13:00–15:00 | 国立西洋美術館 | art_museum | 2h00m |");
    expect(body).not.toContain("（未取得）");
    expect(body).toContain("- 企画展を見た");
    expect(body.match(/kb:location:start/g)?.length).toBe(1);
    expect(fm).toMatchObject({ month: "2026-10", visits: 1, places: 1, unresolved: 0, top_places: ["国立西洋美術館 (1)"] });
    expect(r2.notable.map((n) => n.place!.name)).toEqual(["ボルダリングジム X", "国立西洋美術館"]);
    expect(readMeta(cfg, bronze.id)!.processed_to.sort()).toEqual(r1.months.map((m) => m.path).sort());
    // coordinates never come from the API
    expect(api.calls.every((c) => new Headers(c.init!.headers).get("X-Goog-FieldMask") === "id,displayName,primaryType")).toBe(true);
  });

  test("a JSON that is not a Timeline export and a missing key are clear errors", async () => {
    const { cfg, reg } = kb();
    const p = join(cfg.inbox, "other.json");
    writeFileSync(p, '{"hello":1}');
    const b = ingestFile(cfg, p);
    const db = openDb(cfg);
    await expect(importLocation(cfg, reg, db, b.id, { apiKey: "K" })).rejects.toThrow("no Google Maps Timeline export");
    const t = join(cfg.inbox, "Timeline.json");
    writeFileSync(t, JSON.stringify(ios));
    const b2 = ingestFile(cfg, t);
    const saved = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    await expect(importLocation(cfg, reg, db, b2.id)).rejects.toThrow("Places API key missing");
    if (saved) process.env.GOOGLE_MAPS_API_KEY = saved;
  });
});

describe("wall-clock dates", () => {
  const { localDate } = require("./import") as typeof import("./import");
  test("the export's own offset decides the date (a late night abroad stays on its local day)", () => {
    expect(localDate("2026-10-01T23:30:00.000-07:00")).toBe("2026-10-01");
    expect(localDate("2026-10-01T00:30:00+09:00")).toBe("2026-10-01");
  });
});
