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
      else if (!Number.isNaN(num) && f.value !== "") { where.push(`CAST(${expr} AS REAL) ${f.op} ?`); params.push(num); }
      else { where.push(`${expr} ${sqlOp(f.op)} ?`); params.push(f.value); }
    }
  }
  let sql: string;
  const terms = q.text?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (terms.length && terms.some((t) => [...t].length < 3)) {
    // trigram FTS needs >= 3 chars per term; fall back to LIKE for short (often Japanese) terms
    for (const t of terms) {
      where.push("(n.title LIKE ? OR n.summary LIKE ? OR n.body LIKE ? OR n.tags LIKE ?)");
      params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    }
    const ord = orderClause(q.orderBy ?? "-updated");
    sql = `SELECT n.* FROM notes n WHERE ${where.join(" AND ")} ORDER BY ${ord} LIMIT ?`;
  } else if (q.text) {
    where.push("notes_fts MATCH ?");
    params.push(ftsQuery(q.text));
    sql = `SELECT n.*, bm25(notes_fts) AS score FROM notes_fts JOIN notes n ON n.path = notes_fts.path
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score LIMIT ?`;
  } else {
    const ord = orderClause(q.orderBy ?? "-updated");
    sql = `SELECT n.* FROM notes n ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${ord} LIMIT ?`;
  }
  params.push(q.limit ?? 200);
  const rows = db.query(sql).all(...(params as any[])) as (NoteRow & { score?: number })[];
  return rows.map((r) => ({
    path: r.path, type: r.type, title: r.title, status: r.status, summary: r.summary,
    tags: JSON.parse(r.tags || "[]"), fm: JSON.parse(r.fm), archived: !!r.archived, updated: r.updated, score: r.score,
  }));
}

function sqlOp(op: Filter["op"]): string {
  return op === "~" ? "LIKE" : op;
}
function orderClause(o: string): string {
  const desc = o.startsWith("-");
  const f = desc ? o.slice(1) : o;
  const col = ["path", "type", "title", "status", "updated"].includes(f) ? `n.${f}` : `json_extract(n.fm,'$.${f}')`;
  return `${col} ${desc ? "DESC" : "ASC"}, n.path`;
}
/** Quote each term for FTS5 so Japanese text and punctuation are safe with the trigram tokenizer. */
function ftsQuery(text: string): string {
  return text.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}
