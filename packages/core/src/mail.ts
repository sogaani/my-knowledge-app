/**
 * `kb mail import <bronze-id>... | --all`: the deterministic part of handling Gmail items in Bronze, so the ingest
 * agent only decides what is left.
 *
 *  1. Routine notices (login / security / shipping / e-delivery …) are recognised by the owner's rule table
 *     `900_system/mail-rules.json` (subject / sender patterns, general words only) and marked `processed_to: ["-"]`.
 *  2. Every other money mail (purchase / finance / subscription / book / media) gets an amount, a date and, when
 *     found, a merchant and item pulled out of it: a ledger candidate.
 *  3. Candidates are matched against the ledger notes (203_finance) by date ±1 day + same amount, so a Moneytree row
 *     that already covers the transaction shows as `matched` and the agent does not count it twice.
 *
 * Nothing here writes Silver; the agent appends the rows it accepts. Mail bodies never reach the output: only the
 * header fields, the extracted figures and the rule name.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { LAYOUT, type KbConfig } from "./config";
import { bronzeDir, mailCategory, markProcessed, processState, readMeta, walkBronze, type BronzeMeta } from "./bronze";
import { parseNote } from "./frontmatter";
import { runQuery } from "./query";
import { ledgerRows, type LedgerRow } from "./views";
import type { MailItem } from "./collect/sources/gmail";

export const MAIL_RULES_REL = `${LAYOUT.system}/mail-rules.json`;
/** Categories whose mails carry an amount worth a ledger / subscription / book row. */
export const MONEY_CATEGORIES = ["purchase", "finance", "subscription", "book", "media"] as const;

/** One routine-notice rule: every given pattern must match (case-insensitive regexes); `unless` blocks the match. */
export interface MailRule {
  name: string;
  /** Regex on the subject. */
  subject?: string;
  /** Regex on the From header (display name + address). */
  from?: string;
  /** Regex on the subject that cancels the rule (e.g. a shipping notice that also states the payment). */
  unless?: string;
  /** Limit to these categories (file-name category: purchase / finance / …). Omitted = any. */
  categories?: string[];
  /** Do not apply when an amount can be read out of the mail (a shipping notice that is the only mail stating the price). */
  unless_amount?: boolean;
}
export interface MailRules { version?: number; routine: MailRule[] }

interface CompiledRule { rule: MailRule; subject?: RegExp; from?: RegExp; unless?: RegExp }

export function compileRules(rules: MailRules): CompiledRule[] {
  const re = (name: string, field: string, p?: string) => {
    if (p === undefined) return undefined;
    try { return new RegExp(p, "iu"); } catch (e) { throw new Error(`mail rule "${name}": bad ${field} pattern (${(e as Error).message})`); }
  };
  return (rules.routine ?? []).map((rule) => {
    if (!rule.name) throw new Error("mail rule without a name");
    if (!rule.subject && !rule.from) throw new Error(`mail rule "${rule.name}": needs subject or from`);
    return { rule, subject: re(rule.name, "subject", rule.subject), from: re(rule.name, "from", rule.from), unless: re(rule.name, "unless", rule.unless) };
  });
}

/** The data repo's rule table; a missing file means no routine rules (every mail becomes a candidate). */
export function loadMailRules(cfg: KbConfig): { rules: MailRules; path: string; exists: boolean } {
  const path = join(cfg.root, MAIL_RULES_REL);
  if (!existsSync(path)) return { rules: { routine: [] }, path, exists: false };
  const rules = JSON.parse(readFileSync(path, "utf8")) as MailRules;
  if (!Array.isArray(rules.routine)) throw new Error(`${MAIL_RULES_REL}: "routine" must be an array`);
  return { rules, path, exists: true };
}

/** Header fields of a Gmail item in Bronze (collector JSON or the older Apps Script Markdown). */
export interface ParsedMail { id: string; category: string | null; subject: string; from: string; date: string; body: string; gmail_id: string }

/** The old push format: `# subject`, then `- key: value` lines, then `---`, then the body. */
function parseMailMarkdown(text: string): Omit<ParsedMail, "id" | "category"> {
  const sep = text.indexOf("\n---");
  const head = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? "" : text.slice(sep + 4).replace(/^\s*\n/, "");
  const field = (k: string) => new RegExp(`^- ${k}:\\s*(.*)$`, "m").exec(head)?.[1]?.trim() ?? "";
  return { subject: field("subject"), from: field("from"), date: field("date"), gmail_id: field("gmail_id"), body };
}

export function readMail(cfg: KbConfig, meta: BronzeMeta): ParsedMail | null {
  if (meta.kind !== "mail") return null;
  const file = meta.files.find((f) => /\.json$/i.test(f)) ?? meta.files.find((f) => /\.md$/i.test(f));
  if (!file) return null;
  const text = readFileSync(join(bronzeDir(cfg, meta.id), file), "utf8");
  const category = mailCategory(meta);
  if (file.endsWith(".json")) {
    const m = JSON.parse(text) as Partial<MailItem>;
    if (m.source !== "gmail") return null;
    return { id: meta.id, category: category ?? m.category ?? null, subject: m.subject ?? "", from: m.from ?? "", date: m.date ?? "", body: m.body ?? "", gmail_id: m.gmail_id ?? "" };
  }
  return { id: meta.id, category, ...parseMailMarkdown(text) };
}

/** The first routine rule a mail satisfies, or null. `hasAmount` is consulted (once) only by rules with `unless_amount`. */
export function matchRoutine(mail: Pick<ParsedMail, "subject" | "from" | "category">, rules: CompiledRule[], hasAmount: () => boolean = () => false): MailRule | null {
  let amount: boolean | undefined;
  for (const r of rules) {
    if (r.rule.categories?.length && (!mail.category || !r.rule.categories.includes(mail.category))) continue;
    if (r.subject && !r.subject.test(mail.subject)) continue;
    if (r.from && !r.from.test(mail.from)) continue;
    if (r.unless && r.unless.test(mail.subject)) continue;
    if (r.rule.unless_amount && (amount ??= hasAmount())) continue;
    return r.rule;
  }
  return null;
}

// ---- amount / date / merchant extraction -------------------------------------------------------------------------

export interface Money { amount: number; currency: string }

/** Full-width digits, commas and currency marks to ASCII; NBSP to space. */
const norm = (s: string) => s.normalize("NFKC").replace(/ /g, " ");
const TOTAL_WORDS = /合計|総額|お?支払い?(金)?額|ご?利用(金)?額|ご?請求(金)?額|決済(金)?額|入金額|チャージ金額|お買い?上げ(金)?額|grand total|\btotal\b|amount (paid|charged|due)/i;
const AMOUNT_WORDS = /金額|価格|料金|代金|price|amount/i;
const YEN = /(?:(?:¥|￥|JPY|yen)\s*(\d{1,3}(?:,\d{3})+|\d+)(?!\d)|(\d{1,3}(?:,\d{3})+|\d+)\s*(?:円|JPY\b|yen\b))/gi;
const USD = /(?:(?:US)?\$|USD)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
/** A bare figure (no currency mark), accepted only on a line that names an amount; dates, times, counts and ids excluded. */
const BARE = /(?<![\d,.\/\-:#])(\d{1,3}(?:,\d{3})+|\d{1,7})(?![\d,.\/\-:%]|\s*(?:年|月|日|時|分|秒|個|点|件|名|回|冊|本|%|ポイント|pt\b|pts\b))/g;
const ID_WORDS = /番号|No\.|ID|コード|code/i;
/** A line that is nothing but a figure (an HTML table cell): "¥1,234", "1,234 円（税込）", "1234". */
const FIGURE_ONLY = /^\s*[¥￥]?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*(?:円|JPY|yen)?\s*(?:\((?:税込|税抜|税込み)\))?\s*$/i;

function amountsIn(line: string, keyworded: boolean): Money[] {
  const out: Money[] = [];
  const neg = (i: number) => /[-−]/.test(line.slice(Math.max(0, i - 1), i)); // discounts / points used
  for (const m of line.matchAll(YEN)) {
    if (neg(m.index!)) continue;
    const amount = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (amount > 0) out.push({ amount, currency: "JPY" });
  }
  for (const m of line.matchAll(USD)) {
    const amount = Number(m[1]!.replace(/,/g, ""));
    if (amount > 0) out.push({ amount, currency: "USD" });
  }
  if (!out.length && keyworded && !ID_WORDS.test(line)) {
    for (const m of line.matchAll(BARE)) {
      if (neg(m.index!)) continue;
      const amount = Number(m[1]!.replace(/,/g, ""));
      if (amount > 0) out.push({ amount, currency: "JPY" });
    }
  }
  return out;
}

const rankOf = (line: string) => (TOTAL_WORDS.test(line) ? 2 : AMOUNT_WORDS.test(line) ? 1 : 0);

/**
 * The amount a mail is about: on a line naming a total (合計 / お支払い金額 / Total …) first, else on a line naming an
 * amount at all, else the largest amount anywhere. Within the same rank the last line wins (totals come after items).
 * A figure alone on the line after a keyword (HTML tables flattened to text) inherits that keyword. On a keyword line a
 * bare number counts too ("ご請求金額 1,234").
 */
export function extractAmount(text: string): Money | null {
  let best: { rank: number; money: Money } | null = null;
  const lines = norm(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let rank = rankOf(line);
    if (!rank && i > 0 && FIGURE_ONLY.test(line)) rank = rankOf(lines[i - 1]!);
    const found = amountsIn(line, rank > 0);
    if (!found.length) continue;
    const money = rank ? found[found.length - 1]! : found.reduce((a, b) => (b.amount > a.amount ? b : a));
    if (!best || rank > best.rank || (rank === best.rank && (rank > 0 || money.amount > best.money.amount))) best = { rank, money };
  }
  return best?.money ?? null;
}

const DATE_WORDS = /利用日|注文日|購入日|決済日|お?支払い?日|支払日|取引日|入金日|課金日|日時|日付|\bdate\b|\bordered\b/i;
const DATE_RE = /(\d{4})[/年.\-]\s*(\d{1,2})[/月.\-]\s*(\d{1,2})/;
/** Calendar day (Asia/Tokyo) of an ISO timestamp, or "" when unparsable. */
export const mailDay = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
};

/** The transaction date: a dated line naming the transaction day (利用日 / 注文日 / Date …), else the mail's own date. */
export function extractDate(text: string, mailDate: string): string {
  for (const line of norm(text).split("\n")) {
    if (!DATE_WORDS.test(line)) continue;
    const m = DATE_RE.exec(line);
    if (!m) continue;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return mailDay(mailDate);
}

/** Merchant: the 【…】 / [...] tag in the subject, else the sender's display name, else the sender's domain. */
export function extractMerchant(subject: string, from: string): string {
  const tag = /[【\[]([^】\]]{1,40})[】\]]/.exec(subject)?.[1]?.trim();
  if (tag && !/^(重要|速報版|自動配信|自動送信|お知らせ)$/.test(tag)) return tag;
  const name = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(from)?.[1]?.trim();
  if (name) return name;
  const domain = /@([\w.-]+)/.exec(from)?.[1];
  return domain ?? from.trim();
}

const ITEM_WORDS = /^\s*[-*・]?\s*(?:商品名|品名|商品|件名|サービス名|プラン|item|description|product)\s*[:：]\s*(.+)$/im;
/** A labelled item line (商品名: … / Item: …), clipped; null when the mail has none. */
export function extractItem(text: string): string | null {
  const m = ITEM_WORDS.exec(norm(text));
  const v = m?.[1]?.trim().replace(/\s+/g, " ");
  return v ? (v.length > 60 ? `${v.slice(0, 60)}…` : v) : null;
}

// ---- ledger matching -----------------------------------------------------------------------------------------------

export interface LedgerIndexRow extends LedgerRow { path: string }
export interface LedgerIndex { rows: LedgerIndexRow[]; /** last day with a Moneytree row, or null when none was imported */ moneytreeThrough: string | null }

/** Every 明細 row of every ledger note (203_finance), from the SQLite index. */
export function loadLedger(cfg: KbConfig, db: Database): LedgerIndex {
  const rows: LedgerIndexRow[] = [];
  for (const n of runQuery(db, { filters: [{ field: "type", op: "=", value: "ledger" }] })) {
    const abs = join(cfg.root, n.path);
    if (!existsSync(abs)) continue;
    for (const r of ledgerRows(parseNote(readFileSync(abs, "utf8")).body)) rows.push({ ...r, path: n.path });
  }
  const mt = rows.filter((r) => /moneytree/i.test(r.source)).map((r) => r.date).sort();
  return { rows, moneytreeThrough: mt.length ? mt[mt.length - 1]! : null };
}

export type MatchState = "recorded" | "matched" | "unmatched";
export interface LedgerMatch { state: MatchState; row?: LedgerIndexRow }

const dayDiff = (a: string, b: string) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * `recorded`: a row already cites this Bronze id. `matched`: a row with the same amount within ±1 day (a Moneytree row
 * when there is one). `unmatched`: nothing in the ledger looks like it.
 */
export function matchLedger(c: { id: string; date: string; amount: number; currency: string }, rows: LedgerIndexRow[]): LedgerMatch {
  const own = rows.find((r) => r.source === c.id);
  if (own) return { state: "recorded", row: own };
  if (c.currency !== "JPY" || !c.date) return { state: "unmatched" };
  const near = rows.filter((r) => Math.round(r.amount) === Math.round(c.amount) && dayDiff(r.date, c.date) <= 1);
  const row = near.find((r) => /moneytree/i.test(r.source)) ?? near[0];
  return row ? { state: "matched", row } : { state: "unmatched" };
}

// ---- the import ------------------------------------------------------------------------------------------------------

export type MailDecision = "routine" | "candidate" | "manual";
export interface MailImportItem {
  id: string;
  category: string | null;
  date: string; // mail day (Asia/Tokyo)
  subject: string;
  from: string;
  decision: MailDecision;
  /** routine: the rule that matched */
  rule?: string;
  /** candidate: the figures pulled out of the mail */
  amount?: number;
  currency?: string;
  txDate?: string;
  merchant?: string;
  item?: string;
  match?: MatchState;
  /** candidate: the ledger row it matched (date / source / note) */
  ledger?: { date: string; source: string; path: string };
  /** candidate: Moneytree rows already reach this day (an unmatched candidate on a later day may just be waiting) */
  moneytreeCovered?: boolean;
  /** manual: why no candidate was produced */
  reason?: string;
}
export interface MailImportResult {
  items: MailImportItem[];
  skipped: { id: string; reason: string }[];
  /** ids marked processed_to ["-"] (empty on --dry-run) */
  processed: string[];
  rules: { count: number; path: string; exists: boolean };
  moneytreeThrough: string | null;
}

export interface ImportMailOpts { ids?: string[]; all?: boolean; dryRun?: boolean }

export function importMail(cfg: KbConfig, db: Database, opts: ImportMailOpts): MailImportResult {
  const loaded = loadMailRules(cfg);
  const rules = compileRules(loaded.rules);
  const ledger = loadLedger(cfg, db);
  const res: MailImportResult = { items: [], skipped: [], processed: [], rules: { count: rules.length, path: loaded.path, exists: loaded.exists }, moneytreeThrough: ledger.moneytreeThrough };

  const metas: BronzeMeta[] = [];
  if (opts.all) for (const m of walkBronze(cfg)) { if (m.kind === "mail" && processState(m) === "unprocessed") metas.push(m); }
  for (const id of opts.ids ?? []) {
    const m = readMeta(cfg, id);
    if (!m) { res.skipped.push({ id, reason: "no such Bronze item" }); continue; }
    if (m.kind !== "mail") { res.skipped.push({ id, reason: `kind ${m.kind}, not mail` }); continue; }
    if (processState(m) !== "unprocessed") { res.skipped.push({ id, reason: `already processed (${m.processed_to.join(", ")})` }); continue; }
    if (!metas.some((x) => x.id === m.id)) metas.push(m);
  }
  metas.sort((a, b) => a.id.localeCompare(b.id));

  for (const meta of metas) {
    const mail = readMail(cfg, meta);
    if (!mail) { res.skipped.push({ id: meta.id, reason: "not a Gmail item" }); continue; }
    const base = { id: mail.id, category: mail.category, date: mailDay(mail.date), subject: mail.subject, from: mail.from };
    const money = extractAmount(`${mail.subject}\n${mail.body}`);
    const rule = matchRoutine(mail, rules, () => money !== null);
    if (rule) {
      res.items.push({ ...base, decision: "routine", rule: rule.name });
      if (!opts.dryRun) { markProcessed(cfg, mail.id, ["-"]); res.processed.push(mail.id); }
      continue;
    }
    if (!mail.category || !(MONEY_CATEGORIES as readonly string[]).includes(mail.category)) {
      res.items.push({ ...base, decision: "manual", reason: `category ${mail.category ?? "unknown"}: read it with kb source` });
      continue;
    }
    if (!money) { res.items.push({ ...base, decision: "manual", reason: "no amount found" }); continue; }
    const txDate = extractDate(mail.body, mail.date);
    const m = matchLedger({ id: mail.id, date: txDate, ...money }, ledger.rows);
    res.items.push({
      ...base, decision: "candidate", ...money, txDate, merchant: extractMerchant(mail.subject, mail.from),
      ...(extractItem(mail.body) ? { item: extractItem(mail.body)! } : {}),
      match: m.state, ...(m.row ? { ledger: { date: m.row.date, source: m.row.source, path: m.row.path } } : {}),
      moneytreeCovered: ledger.moneytreeThrough !== null && txDate <= ledger.moneytreeThrough,
    });
  }
  return res;
}

const yen = (n: number, cur: string) => (cur === "JPY" ? `¥${Math.round(n).toLocaleString("ja-JP")}` : `${cur} ${n}`);

/** Console rendering for the ingest agent: counts first, then one line per mail. */
export function formatMailImport(r: MailImportResult, opts: { dryRun?: boolean } = {}): string {
  const by = (d: MailDecision) => r.items.filter((i) => i.decision === d);
  const routine = by("routine"), cand = by("candidate"), manual = by("manual");
  const out: string[] = [
    `rules: ${r.rules.count}${r.rules.exists ? "" : ` (${MAIL_RULES_REL} missing)`} / moneytree rows through: ${r.moneytreeThrough ?? "none"}`,
    `routine ${routine.length}${opts.dryRun ? " (dry-run, not marked)" : " (marked processed: -)"} / candidates ${cand.length} / manual ${manual.length} / skipped ${r.skipped.length}`,
  ];
  if (routine.length) { out.push("", "## routine"); for (const i of routine) out.push(`- ${i.id}  ${i.category ?? "?"}  ${i.date}  ${i.subject}  [${i.rule}]`); }
  if (cand.length) {
    out.push("", "## candidates (date / amount / merchant / ledger match)");
    for (const i of cand) {
      const match = i.match === "matched" ? `matched (${i.ledger!.source} ${i.ledger!.date})` : i.match === "recorded" ? `recorded (${i.ledger!.path})` : i.moneytreeCovered ? "unmatched" : "unmatched (moneytree not pulled for this day yet)";
      out.push(`- ${i.id}  ${i.category}  ${i.txDate}  ${yen(i.amount!, i.currency!)}  ${i.merchant}${i.item ? ` / ${i.item}` : ""}  → ${match}  「${i.subject}」`);
    }
  }
  if (manual.length) { out.push("", "## manual (kb source <id>)"); for (const i of manual) out.push(`- ${i.id}  ${i.category ?? "?"}  ${i.date}  ${i.subject}  (${i.reason})`); }
  if (r.skipped.length) { out.push("", "## skipped"); for (const s of r.skipped) out.push(`- ${s.id}  ${s.reason}`); }
  return out.join("\n");
}
