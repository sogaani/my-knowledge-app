/**
 * Google Maps Timeline exports → place visits. Three shapes exist:
 *   android  — on-device export `Timeline.json`: { semanticSegments: [{ startTime, endTime, visit: { topCandidate: { placeId, semanticType, placeLocation: { latLng: "35.6°, 139.7°" } } } }] }
 *   ios      — on-device export from iPhone: [{ startTime, endTime, visit: { topCandidate: { placeID, semanticType, placeLocation: "geo:35.6,139.7" } } }]
 *   takeout  — old Takeout "Semantic Location History/YYYY/YYYY_MONTH.json": { timelineObjects: [{ placeVisit: { location: { placeId, latitudeE7, longitudeE7, semanticType }, duration: { startTimestamp | startTimestampMs, endTimestamp | endTimestampMs } } }] }
 */

export type TimelineSource = "android" | "ios" | "takeout";

export interface Visit {
  start: string; // ISO 8601
  end: string;
  placeId: string;
  lat: number | null;
  lng: number | null;
  semanticType?: string;
  source: TimelineSource;
}

export class NotATimelineError extends Error {
  constructor() { super("not a Google Maps Timeline export (expected semanticSegments, a segment array, or timelineObjects)"); }
}

/** "35.6°, 139.7°" | "geo:35.6,139.7" | "35.6, 139.7" | { latLng: … } → [lat, lng] */
export function parseLatLng(v: unknown): [number, number] | [null, null] {
  const s = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { latLng?: unknown }).latLng === "string" ? (v as { latLng: string }).latLng : "";
  const m = /(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/.exec(s.replace(/^geo:/, ""));
  if (!m) return [null, null];
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : [null, null];
}

const iso = (v: unknown): string | null => {
  if (typeof v === "number" || (typeof v === "string" && /^\d{10,}$/.test(v))) return new Date(Number(v)).toISOString(); // *TimestampMs
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : v;
};

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

/** Segments of the on-device exports (android: semanticSegments[], ios: top-level array). */
function fromSegments(segments: unknown[], source: TimelineSource): Visit[] {
  const out: Visit[] = [];
  for (const s of segments) {
    const seg = obj(s), cand = obj(obj(seg?.visit)?.topCandidate);
    if (!seg || !cand) continue; // activity / path segments
    const placeId = String(cand.placeId ?? cand.placeID ?? "");
    const start = iso(seg.startTime), end = iso(seg.endTime);
    if (!placeId || !start || !end) continue;
    const [lat, lng] = parseLatLng(cand.placeLocation);
    out.push({ start, end, placeId, lat, lng, ...(typeof cand.semanticType === "string" ? { semanticType: cand.semanticType } : {}), source });
  }
  return out;
}

function fromTakeout(objects: unknown[]): Visit[] {
  const out: Visit[] = [];
  for (const o of objects) {
    const pv = obj(obj(o)?.placeVisit);
    const loc = obj(pv?.location), dur = obj(pv?.duration);
    if (!loc || !dur) continue;
    const placeId = String(loc.placeId ?? "");
    const start = iso(dur.startTimestamp ?? dur.startTimestampMs), end = iso(dur.endTimestamp ?? dur.endTimestampMs);
    if (!placeId || !start || !end) continue;
    const e7 = (v: unknown) => (typeof v === "number" ? v / 1e7 : null);
    out.push({ start, end, placeId, lat: e7(loc.latitudeE7), lng: e7(loc.longitudeE7), ...(typeof loc.semanticType === "string" ? { semanticType: loc.semanticType } : {}), source: "takeout" });
  }
  return out;
}

/** Visits in start order. Throws NotATimelineError for any other JSON. */
export function parseTimeline(json: unknown): Visit[] {
  let visits: Visit[];
  const root = obj(json);
  if (root && Array.isArray(root.semanticSegments)) visits = fromSegments(root.semanticSegments, "android");
  else if (root && Array.isArray(root.timelineObjects)) visits = fromTakeout(root.timelineObjects);
  else if (Array.isArray(json) && json.some((s) => obj(s)?.startTime !== undefined)) visits = fromSegments(json, "ios");
  else throw new NotATimelineError();
  return visits.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Quick check on raw text without parsing it twice (for the Bronze file picker). */
export const looksLikeTimeline = (text: string) => /"(semanticSegments|timelineObjects)"\s*:|"topCandidate"\s*:/.test(text.slice(0, 200_000));
