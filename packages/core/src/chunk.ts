/**
 * Split a Silver note into retrieval chunks. One chunk per H2 section (plus a header chunk made of
 * title / summary / tags / scalar frontmatter), spoiler callouts isolated into their own chunks.
 *
 * Noise control (v2): the leading `# title` line is dropped (the header chunk already carries the title),
 * URLs are stripped from the indexed text (link text stays), only title + tags prefix every chunk's
 * embedText (the summary lives in the header chunk alone), and a note whose body yields no chunk is
 * marked `thin` so the search side can rank it below notes with real content.
 */
import { createHash } from "node:crypto";
import type { Note } from "./notes";

/** Bump when the chunking rules change; forces a full re-embed. */
export const CHUNKER_VERSION = 2;

export interface Chunk {
  /** `${path}#${idx}` */
  id: string;
  /** file the text came from (README.md or an attachment like log.md) */
  path: string;
  /** the note this chunk belongs to (README.md for folder entities) */
  notePath: string;
  idx: number;
  heading: string;
  /** stored + shown as snippet + indexed by FTS (URLs removed) */
  text: string;
  /** what gets embedded: context header + text */
  embedText: string;
  spoiler: boolean;
  /** the note has no body chunk — only this header chunk (title / summary / frontmatter) */
  thin: boolean;
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
  const push = (path: string, heading: string, text: string, spoiler: boolean, embedText?: string) => {
    const t = text.trim();
    if (!t) return;
    out.push({ id: `${n.path}#${idx}`, path, notePath: n.path, idx, heading, text: t, embedText: embedText ?? `${header}${heading ? `## ${heading}\n` : ""}${t}`, spoiler, thin: false });
    idx++;
  };

  // 0: header chunk — makes the note findable by title / author / tags even with an empty body.
  // Its embedText is the chunk itself (title as H1) rather than header + text, so the title is not repeated.
  const headerText = headerChunkText(n);
  push(n.path, "", headerText, false, `# ${headerText}`);

  // URLs go before splitting so a hard split never leaves half a URL behind
  for (const sec of splitSections(stripUrls(dropLeadingTitle(n.body, n.title)))) {
    for (const seg of splitSpoilers(sec.lines)) {
      for (const piece of splitLong(seg.text, maxChars, overlap)) push(n.path, sec.heading, piece, seg.spoiler);
    }
  }
  for (const a of attachments) {
    const name = a.path.split("/").pop()!.replace(/\.md$/, "");
    for (const sec of splitSections(stripUrls(dropLeadingTitle(a.body, n.title)))) {
      const heading = sec.heading ? `${name} / ${sec.heading}` : name;
      for (const seg of splitSpoilers(sec.lines)) {
        for (const piece of splitLong(seg.text, maxChars, overlap)) push(a.path, heading, piece, seg.spoiler);
      }
    }
  }
  if (out.length === 1) out[0].thin = true;
  return out;
}

/** Prefix for every body chunk's embedText: title and tags only (the summary would make all chunks of a note look alike). */
function contextHeader(n: Note): string {
  const lines = [`# ${n.title}`];
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
    const s = stripUrls(Array.isArray(v) ? v.map(String).join(", ") : String(v)).trim();
    if (s && s.length <= 200) lines.push(`${k}: ${s}`);
  }
  return lines.join("\n");
}

/**
 * Drop the body's leading `# …` line when it is the note's title (or contains it, e.g. `# 2026-10 予定` for
 * title `2026-10`, `# X — ログ` in a project's log.md): it would otherwise become a chunk of its own that
 * says nothing the header chunk does not.
 */
export function dropLeadingTitle(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*[ \t]*(?:\r?\n|$)/.exec(body);
  if (!m) return body;
  const h = m[1].trim(), t = title.trim();
  if (!t || !(h === t || h.includes(t))) return body;
  return body.slice(m[0].length);
}

const MD_LINK_RE = /!?\[([^\]]*)\]\((?:<[^>]*>|[^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g;
const AUTOLINK_RE = /<(?:https?|ftp|mailto):[^>\s]+>/gi;
/** Bare URLs end at whitespace, ASCII brackets/quotes or CJK punctuation (U+3000–U+303F, full-width forms); non-ASCII path chars stay part of the URL. */
const BARE_URL_RE = /(?:https?|ftp):\/\/[^\s<>"'`)\]\u3000-\u303f\uff00-\uff65]+/gi;

/**
 * Remove URLs so they neither skew the embedding nor pollute BM25: `[text](url)` → `text`,
 * `![alt](url)` → `alt`, `<https://…>` and bare URLs → nothing. Lines left empty are dropped.
 */
export function stripUrls(text: string): string {
  if (!/:\/\/|\]\(/.test(text)) return text;
  const s = text.replace(MD_LINK_RE, "$1").replace(AUTOLINK_RE, "").replace(BARE_URL_RE, "");
  return s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).join("\n");
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

/** Body text without its `> [!spoiler]` callouts (for excerpts shown outside the vector path). */
export function stripSpoilers(body: string): string {
  return splitSpoilers(body.split("\n")).filter((s) => !s.spoiler).map((s) => s.text).join("\n");
}

/**
 * Separate `> [!spoiler]` callouts (and the quote lines that follow them) from ordinary text.
 * A callout with only its title line (the template's empty `> [!spoiler]- ネタバレ`) is dropped.
 */
function splitSpoilers(lines: string[]): { text: string; spoiler: boolean }[] {
  const segs: { text: string; spoiler: boolean }[] = [];
  let cur: string[] = [];
  let spoiler = false;
  const flush = () => {
    if (cur.length && !(spoiler && !cur.slice(1).some((l) => l.trim()))) segs.push({ text: cur.join("\n"), spoiler });
    cur = [];
  };
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
