/**
 * LinkedIn: the "Get a copy of your data" export ZIP dropped into 000_inbox. LinkedIn has no API for a member's own
 * connections or messages outside the EU/EEA, so the export is the source. The feed carries profile + positions and
 * only the connections / messages that are new since the previous export; the ZIP itself is ingested to Bronze as-is.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { csvObjects } from "../csv";
import type { Collector } from "../types";

export const LINKEDIN_ZIP = /LinkedInDataExport.*\.zip$/i;
/** Profile fields not copied into the feed (the raw ZIP in Bronze still has everything). */
const PROFILE_DROP = ["Address", "Birth Date", "Zip Code", "Instant Messengers", "Maiden Name"];

interface Cursor { zips: string[]; connections: string[]; lastMessageAt?: string }
type Item =
  | { section: "profile"; row: Record<string, string> }
  | { section: "position"; row: Record<string, string> }
  | { section: "connection"; row: Record<string, string> }
  | { section: "message"; row: Record<string, string> };

async function readEntry(zip: string, entry: string): Promise<string | null> {
  const p = Bun.spawn(["unzip", "-p", zip, entry], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return (await p.exited) === 0 && out ? out : null;
}

async function listEntries(zip: string): Promise<string[]> {
  const p = Bun.spawn(["unzip", "-Z1", zip], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`cannot read ${zip.split("/").pop()} (not a zip?)`);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** LinkedIn message dates look like "2026-10-01 12:34:56 UTC". */
const msgTime = (s: string | undefined) => (s ? Date.parse(s.replace(" UTC", "Z").replace(" ", "T")) || 0 : 0);

export const linkedin: Collector = {
  id: "linkedin",
  label: "LinkedIn (export ZIP)",
  lookbackDays: 0,
  configured: () => true, // nothing to configure: runs when a ZIP is in the inbox
  async collect({ cfg, cursor }) {
    const cur: Cursor = cursor ? JSON.parse(cursor) : { zips: [], connections: [] };
    let zips: string[] = [];
    try { zips = readdirSync(cfg.inbox).filter((f) => LINKEDIN_ZIP.test(f)).map((f) => join(cfg.inbox, f)).filter((p) => statSync(p).isFile()); } catch { /* no inbox yet */ }
    const fresh = zips
      .map((z) => ({ path: z, sha: createHash("sha256").update(readFileSync(z)).digest("hex"), mtime: statSync(z).mtime }))
      .filter((z) => !cur.zips.includes(z.sha))
      .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
    if (!fresh.length) return {};

    const zip = fresh[fresh.length - 1]!; // newest export wins; older unprocessed ones are just marked seen
    const entries = await listEntries(zip.path);
    const find = (name: string) => entries.find((e) => e.split("/").pop()?.toLowerCase() === name.toLowerCase());
    const read = async (name: string, headerStarts?: string) => {
      const e = find(name);
      const t = e ? await readEntry(zip.path, e) : null;
      return t ? csvObjects(t, headerStarts) : [];
    };

    const [profile, positions, connections, messages] = await Promise.all([
      read("Profile.csv"), read("Positions.csv"), read("Connections.csv", "First Name"), read("messages.csv"),
    ]);
    const known = new Set(cur.connections);
    const connKey = (r: Record<string, string>) => r.URL || `${r["First Name"]} ${r["Last Name"]}|${r.Company}`;
    const newConnections = connections.filter((r) => !known.has(connKey(r)));
    const since = cur.lastMessageAt ? Date.parse(cur.lastMessageAt) : 0;
    const newMessages = messages.filter((r) => msgTime(r.DATE) > since).sort((a, b) => msgTime(a.DATE) - msgTime(b.DATE));
    const lastMessageAt = messages.reduce((a, r) => Math.max(a, msgTime(r.DATE)), since);

    const items: Item[] = [
      ...profile.map((row) => ({ section: "profile" as const, row: Object.fromEntries(Object.entries(row).filter(([k]) => !PROFILE_DROP.includes(k))) })),
      ...positions.map((row) => ({ section: "position" as const, row })),
      ...newConnections.map((row) => ({ section: "connection" as const, row })),
      ...newMessages.map((row) => ({ section: "message" as const, row })),
    ];
    const next: Cursor = {
      zips: [...cur.zips, ...fresh.map((z) => z.sha)],
      connections: [...new Set([...cur.connections, ...connections.map(connKey)])],
      ...(lastMessageAt ? { lastMessageAt: new Date(lastMessageAt).toISOString() } : {}),
    };
    return {
      items,
      meta: { zip: zip.path.split("/").pop(), connections_total: connections.length, connections_new: newConnections.length, messages_new: newMessages.length },
      cursor: JSON.stringify(next),
      from: cur.lastMessageAt ? new Date(cur.lastMessageAt) : zip.mtime,
      to: zip.mtime,
    };
  },
  digest(item) {
    const { section, row } = item as Item;
    switch (section) {
      case "profile": return `プロフィール ${row["First Name"] ?? ""} ${row["Last Name"] ?? ""} — ${row.Headline ?? ""}`;
      case "position": return `職歴 ${row["Started On"] ?? ""}〜${row["Finished On"] || "現在"} ${row["Company Name"] ?? ""} / ${row.Title ?? ""}`;
      case "connection": return `つながり ${row["Connected On"] ?? ""} ${row["First Name"] ?? ""} ${row["Last Name"] ?? ""} (${row.Company ?? ""} / ${row.Position ?? ""})`;
      case "message": return `メッセージ ${(row.DATE ?? "").slice(0, 16)} ${row.FROM ?? ""} → ${row.TO ?? ""} 「${row["CONVERSATION TITLE"] || row.SUBJECT || ""}」 ${(row.CONTENT ?? "").replace(/\s+/g, " ").slice(0, 80)}`;
    }
  },
};
