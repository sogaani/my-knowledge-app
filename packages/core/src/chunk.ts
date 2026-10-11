/**
 * Split a Silver note into retrieval chunks. One chunk per H2 section (plus a header chunk made of
 * title / summary / tags / scalar frontmatter), spoiler callouts isolated into their own chunks.
 */
import { createHash } from "node:crypto";
import type { Note } from "./notes";

/** Bump when the chunking rules change; forces a full re-embed. */
export const CHUNKER_VERSION = 1;

export interface Chunk {
  /** `${path}#${idx}` */
  id: string;
  /** file the text came from (README.md or an attachment like log.md) */
  path: string;
  /** the note this chunk belongs to (README.md for folder entities) */
  notePath: string;
  idx: number;
  heading: string;
  /** stored + shown as snippet + indexed by FTS */
  text: string;
  /** what gets embedded: context header + text */
  embedText: string;
  spoiler: boolean;
}

export interface ChunkOptions { maxChars?: number; overlap?: number }

const FM_SKIP = new Set(["type", "title", "status", "tags", "created", "updated", "sources", "related", "summary", "login_ref"]);
const SPOILER_RE = /^>\s*\[!spoiler\][-+]?/i;

export function noteHash(n: Note, attachments: { path: string; body: string }[] = []): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(n.fm));
  h.update("\n--body--\n");
  h.update(n.body);
  for (const a of attachments) h.update(`\n--${a.path}--\n${a.body}`);
  h.update(`\nchunker=${CHUNKER_VERSION}`);
  return h.digest("hex").slice(0, 24);
}

export function chunkNote(n: Note, attachments: { path: string; body: string }[] = [], opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1000;
  const overlap = opts.overlap ?? 120;
  const header = contextHeader(n);
  const out: Chunk[] = [];
  let idx = 0;
  const push = (path: string, heading: string, text: string, spoiler: boolean) => {
    const t = text.trim();
    if (!t) return;
    out.push({ id: `${n.path}#${idx}`, path, notePath: n.path, idx, heading, text: t, embedText: `${header}${heading ? `## ${heading}\n` : ""}${t}`, spoiler });
    idx++;
  };

  // 0: header chunk — makes the note findable by title / author / tags even with an empty body
  push(n.path, "", headerChunkText(n), false);

  for (const sec of splitSections(n.body)) {
    for (const seg of splitSpoilers(sec.lines)) {
      for (const piece of splitLong(seg.text, maxChars, overlap)) push(n.path, sec.heading, piece, seg.spoiler);
    }
  }
  for (const a of attachments) {
    const name = a.path.split("/").pop()!.replace(/\.md$/, "");
    for (const sec of splitSections(a.body)) {
      const heading = sec.heading ? `${name} / ${sec.heading}` : name;
      for (const seg of splitSpoilers(sec.lines)) {
        for (const piece of splitLong(seg.text, maxChars, overlap)) push(a.path, heading, piece, seg.spoiler);
      }
    }
  }
  return out;
}

function contextHeader(n: Note): string {
  const lines = [`# ${n.title}`];
  if (n.summary) lines.push(n.summary);
  if (n.tags.length) lines.push(`tags: ${n.tags.join(", ")}`);
  return lines.join("\n") + "\n";
}

function headerChunkText(n: Note): string {
  const lines = [n.title];
  if (n.summary) lines.push(n.summary);
  if (n.tags.length) lines.push(`tags: ${n.tags.join(", ")}`);
  for (const [k, v] of Object.entries(n.fm)) {
    if (FM_SKIP.has(k) || v == null || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) continue;
    const s = Array.isArray(v) ? v.map(String).join(", ") : String(v);
    if (s && s.length <= 200) lines.push(`${k}: ${s}`);
  }
  return lines.join("\n");
}

function splitSections(body: string): { heading: string; lines: string[] }[] {
  const secs: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) secs.push({ heading: m[1].trim(), lines: [] });
    else secs[secs.length - 1].lines.push(line);
  }
  return secs.filter((s) => s.lines.some((l) => l.trim()));
}

/** Separate `> [!spoiler]` callouts (and the quote lines that follow them) from ordinary text. */
function splitSpoilers(lines: string[]): { text: string; spoiler: boolean }[] {
  const segs: { text: string; spoiler: boolean }[] = [];
  let cur: string[] = [];
  let spoiler = false;
  const flush = () => { if (cur.length) segs.push({ text: cur.join("\n"), spoiler }); cur = []; };
  for (const line of lines) {
    if (SPOILER_RE.test(line)) { flush(); spoiler = true; cur.push(line.replace(SPOILER_RE, "").trim()); continue; }
    if (spoiler) {
      if (/^>/.test(line)) { cur.push(line.replace(/^>\s?/, "")); continue; }
      flush(); spoiler = false;
    }
    cur.push(line);
  }
  flush();
  return segs;
}

/** Split on paragraph boundaries up to maxChars; hard-split oversized paragraphs with overlap. */
export function splitLong(text: string, maxChars: number, overlap: number): string[] {
  const t = text.trim();
  if (t.length <= maxChars) return t ? [t] : [];
  const out: string[] = [];
  let buf = "";
  for (const para of t.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    if (para.length > maxChars) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        out.push(para.slice(i, i + maxChars));
        if (i + maxChars >= para.length) break;
      }
      continue;
    }
    if (buf && buf.length + para.length + 2 > maxChars) { out.push(buf); buf = ""; }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf) out.push(buf);
  return out;
}
