/** RFC 4180 CSV: quoted fields may contain commas, doubled quotes and newlines (LinkedIn messages do). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Rows as objects keyed by the header row. `headerStarts` finds the header when the file has a preamble
 * (LinkedIn's Connections.csv starts with "Notes:" lines).
 */
export function csvObjects(text: string, headerStarts?: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const hi = headerStarts ? rows.findIndex((r) => r[0]?.trim() === headerStarts) : 0;
  if (hi < 0) return [];
  const head = rows[hi]!.map((h) => h.trim());
  return rows.slice(hi + 1).filter((r) => r.some((v) => v.trim() !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
