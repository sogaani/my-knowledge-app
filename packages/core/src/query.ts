import type { Database } from "bun:sqlite";
import type { NoteRow } from "./db";

export interface QueryOpts {
  filters: Filter[];
  text?: string;
  includeArchive?: boolean;
  limit?: number;
  orderBy?: string; // e.g. "-updated"
}
export interface Filter { field: string; op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "~"; value: string }

const OPS = [">=", "<=", "!=", "=", ">", "<", "~"] as const;

/** Parse tokens like `type=book rating>=4 tags~horror`. Returns leftover tokens too. */
export function parseFilters(tokens: string[]): { filters: Filter[]; rest: string[] } {
  const filters: Filter[] = [];
  const rest: string[] = [];
  for (const t of tokens) {
    const op = OPS.find((o) => t.includes(o));
    if (!op || t.startsWith("-")) { rest.push(t); continue; }
    const [field, ...v] = t.split(op);
    filters.push({ field, op, value: v.join(op) });
  }
  return { filters, rest };
}

export interface QueryResult {
  path: string; type: string; title: string; status: string; summary: string; tags: string[];
  fm: Record<string, unknown>; archived: boolean; updated: string; score?: number;
  /** With `text`: how many of its terms the note contains (all of them when the AND pass had results). */
  matched?: number;
}

export function runQuery(db: Database, q: QueryOpts): QueryResult[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!q.includeArchive) where.push("n.archived = 0");
  for (const f of q.filters) {
    if (["type", "title", "status", "updated"].includes(f.field)) {
      where.push(`n.${f.field} ${sqlOp(f.op)} ?`);
      params.push(f.op === "~" ? `%${f.value}%` : f.value);
    } else if (f.field === "tags") {
      where.push(`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value ${f.op === "~" ? "LIKE" : "="} ?)`);
      params.push(f.op === "~" ? `%${f.value}%` : f.value);
    } else {
      const expr = `json_extract(n.fm, '$.${f.field}')`;
      const num = Number(f.value);
      if (f.op === "~") { where.push(`${expr} LIKE ?`); params.push(`%${f.value}%`); }
      // `rating=` / `rating!=`: the field is unset (missing, null or "" from a template)
      else if (f.value === "" && (f.op === "=" || f.op === "!=")) where.push(`${f.op === "!=" ? "NOT " : ""}(${expr} IS NULL OR ${expr} = '')`);
      // `imported=true`: json_extract yields 1 / 0 for a YAML boolean
      else if (f.value === "true" || f.value === "false") { where.push(`${expr} ${sqlOp(f.op)} ?`); params.push(f.value === "true" ? 1 : 0); }
      else if (!Number.isNaN(num) && f.value !== "") { where.push(`CAST(${expr} AS REAL) ${f.op} ?`); params.push(num); }
      else { where.push(`${expr} ${sqlOp(f.op)} ?`); params.push(f.value); }
    }
  }
  const terms = queryTerms(q.text ?? "");
  let sql: string;
  if (terms.length) {
    // Text search on the trigram FTS5 table. Every term is checked with LIKE (substring, so 1–2 char Japanese
    // words work; the trigram MATCH cannot see them) and `matched` counts the terms a note contains. Terms of
    // >= 3 chars also go through MATCH so bm25 (title 10, summary 5, tags 3, body 1) orders notes of equal
    // coverage; shorter terms get the same column weights by LIKE. Rows come back best coverage first, so the
    // caller keeps only full (AND) matches when any exist and otherwise falls back to the partial (OR) ones.
    const like = (col: string) => `${col} LIKE ? ESCAPE '\\'`;
    const pat = (t: string) => `%${t.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const cols = ["n.title", "n.summary", "n.tags", "n.body"];
    const sel: string[] = [], selParams: unknown[] = [];
    sel.push(terms.map(() => `(${cols.map(like).join(" OR ")})`).join(" + ") + " AS matched");
    for (const t of terms) selParams.push(...cols.map(() => pat(t)));
    const weights = [10, 5, 3, 1];
    const short = terms.filter((t) => [...t].length < 3);
    const long = terms.filter((t) => [...t].length >= 3);
    const parts = short.map(() => `(${cols.map((c, i) => `(${like(c)}) * ${weights[i]}`).join(" + ")})`);
    if (long.length) parts.push("COALESCE(-f.s, 0)");
    sel.push(`(${parts.join(" + ")}) AS score`);
    for (const t of short) selParams.push(...cols.map(() => pat(t)));
    const join = long.length ? `LEFT JOIN (SELECT path, bm25(notes_fts, 0, ${weights.join(", ")}) AS s FROM notes_fts WHERE notes_fts MATCH ?) f ON f.path = n.path` : "";
    if (long.length) selParams.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR "));
    params.unshift(...selParams);
    sql = `SELECT * FROM (SELECT n.*, ${sel.join(", ")} FROM notes n ${join} ${where.length ? "WHERE " + where.join(" AND ") : ""})
      WHERE matched > 0 ORDER BY matched DESC, ${q.orderBy ? orderClause(q.orderBy, "") : "score DESC, updated DESC, path"} LIMIT ?`;
  } else {
    sql = `SELECT n.* FROM notes n ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderClause(q.orderBy ?? "-updated")} LIMIT ?`;
  }
  params.push(q.limit ?? 200);
  let rows = db.query(sql).all(...(params as any[])) as (NoteRow & { score?: number; matched?: number })[];
  if (terms.length && rows[0]?.matched === terms.length) rows = rows.filter((r) => r.matched === terms.length);
  return rows.map((r) => ({
    path: r.path, type: r.type, title: r.title, status: r.status, summary: r.summary,
    tags: JSON.parse(r.tags || "[]"), fm: JSON.parse(r.fm), archived: !!r.archived, updated: r.updated, score: r.score, matched: r.matched,
  }));
}

function sqlOp(op: Filter["op"]): string {
  return op === "~" ? "LIKE" : op;
}
function orderClause(o: string, alias = "n."): string {
  const desc = o.startsWith("-");
  const f = desc ? o.slice(1) : o;
  const col = ["path", "type", "title", "status", "updated"].includes(f) ? `${alias}${f}` : `json_extract(${alias}fm,'$.${f}')`;
  return `${col} ${desc ? "DESC" : "ASC"}, ${alias}path`;
}

const HAN = "\\p{Script=Han}々〆ヵヶ", KATA = "\\p{Script=Katakana}ー", HIRA = "\\p{Script=Hiragana}ー";
/** Runs of one character class: kanji, katakana, hiragana, or other letters/digits (with inner `-._+#/@'`). */
const RUN_RE = new RegExp(`[${HAN}]+|[${KATA}]+|[${HIRA}]+|(?:(?![${HAN}${KATA}${HIRA}])[\\p{L}\\p{N}])+(?:['\\-._+#/@](?:(?![${HAN}${KATA}${HIRA}])[\\p{L}\\p{N}])+)*`, "gu");
const HIRA_RE = new RegExp(`^[${HIRA}]+$`, "u");
const KATA_LONG_RE = new RegExp(`^[${KATA}]{3,}ー$`, "u");
const len = (s: string) => [...s].length;

/**
 * Split a query into search terms without a dictionary: whitespace first, then each piece by character class
 * (kanji / katakana / alphanumerics). Hiragana runs (particles, okurigana) and 1-char runs are dropped, so
 * 「孤島が舞台のミステリー」 → ["孤島", "舞台", "ミステリ"]: a trailing ー on a katakana word is dropped so both
 * spellings (ミステリ/ミステリー, サーバ/サーバー) match as substrings. A piece that is hiragana only (「おすすめ」)
 * is kept as typed. If nothing survives, the whitespace-split pieces are returned so odd input still searches.
 */
export function queryTerms(text: string): string[] {
  const pieces = text.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    const runs = piece.match(RUN_RE) ?? [];
    const kept = runs.filter((r) => !HIRA_RE.test(r) && len(r) >= 2).map((r) => (KATA_LONG_RE.test(r) ? r.slice(0, -1) : r));
    if (kept.length) out.push(...kept);
    else if (runs.length === 1 && HIRA_RE.test(runs[0]) && len(runs[0]) >= 2) out.push(runs[0]);
  }
  return [...new Set(out.length ? out : pieces)];
}
