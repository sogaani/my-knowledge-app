/**
 * Wall-clock date / time of a timestamp where it happened: "…T10:00:00+09:00" keeps its own local date and time (a trip
 * abroad shows local times). All-day dates ("YYYY-MM-DD") are returned as is. Only offset-less / UTC stamps ("…Z") fall
 * back to this machine's zone.
 */
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const localDate = (iso: string) => (DATE_ONLY.test(iso) ? iso : WALL.exec(iso)?.[1] ?? new Date(iso).toLocaleDateString("sv-SE"));
export const localTime = (iso: string) => (DATE_ONLY.test(iso) ? "" : WALL.exec(iso)?.[2] ?? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }));
