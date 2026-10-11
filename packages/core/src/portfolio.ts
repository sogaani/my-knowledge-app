import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { today, type KbConfig } from "./config";
import { parseNote, stringifyNote } from "./frontmatter";
import { createNote } from "./create";
import { bronzeDir, markProcessed, readMeta } from "./bronze";
import { runQuery } from "./query";
import type { SchemaRegistry } from "./schema";
import { decodeText } from "./text";

export { decodeText } from "./text";

/** One RFC 4180 line: quoted fields may contain commas; "" is an escaped quote. No embedded newlines. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  const s = line.replace(/\r$/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface Holding {
  kind: string; // 国内株式 | 米国株式 | 投資信託 | 外貨預り金 …
  code: string;
  name: string;
  account: string; // 特定 | NISA成長投資枠 | NISAつみたて投資枠 | 旧NISA
  qty: number | null;
  unit: string;
  avgCost: number | null;
  price: number | null;
  priceUnit: string;
  change: number | null;
  valueJpy: number | null;
  valueFx: number | null;
  plJpy: number | null;
  plPct: number | null;
}

export interface Portfolio {
  asOf: string;
  summary: Record<string, number | null>; // 資産合計欄: label -> 時価評価額[円]
  holdings: Holding[];
  fx: Record<string, number>; // 参考為替: "USD" -> 円/USD
  totalValue: number | null;
  cashJpy: number | null; // 預り金
  marginDeposit: number | null; // 国内株式信用保証金
  buyingPower: number; // 預り金 + 信用保証金（現物買付に使う）
  cashUsd: number | null; // 外貨預り金 USD
  fxUsdJpy: number | null;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(/[,+％%円]/g, "");
  if (t === "" || t === "-" || t === "未取得") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const cleanName = (s: string) => s.replace(/\u3000/g, "").normalize("NFKC").replace(/\s+/g, " ").trim();

/** Date embedded in the export filename: assetbalance(all)_YYYYMMDD_HHMMSS.csv */
export function asOfFromName(name: string): string | null {
  const m = /_(\d{4})(\d{2})(\d{2})_\d{6}\.csv$/i.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Parse a 楽天証券「資産残高（すべて）」CSV (already decoded to a string). */
export function parseRakutenAssetCsv(text: string, opts: { asOf?: string | null } = {}): Portfolio {
  const summary: Record<string, number | null> = {};
  const holdings: Holding[] = [];
  const fx: Record<string, number> = {};
  let section = "";
  let header: string[] | null = null;
  for (const raw of text.split("\n")) {
    const cells = parseCsvLine(raw);
    const first = (cells[0] ?? "").trim();
    if (!first && cells.length <= 1) continue;
    if (first.startsWith("■")) {
      section = first.replace(/[\s　]/g, "");
      header = null;
      continue;
    }
    if (section.startsWith("■資産合計")) {
      if (first && cells.length > 1 && !/時価評価額/.test(cells[1] ?? "")) summary[first] = num(cells[1]);
    } else if (section.startsWith("■保有商品詳細")) {
      if (first === "種別") { header = cells.map((c) => c.trim()); continue; }
      if (!header || !first) continue;
      const col = (name: string, nth = 0) => {
        let seen = 0;
        for (let i = 0; i < header!.length; i++) if (header![i] === name && seen++ === nth) return cells[i];
        return undefined;
      };
      holdings.push({
        kind: first,
        code: (col("銘柄コード・ティッカー") ?? "").trim(),
        name: cleanName(col("銘柄") ?? ""),
        account: (col("口座") ?? "").trim(),
        qty: num(col("保有数量")),
        unit: (col("［単位］", 0) ?? "").trim(),
        avgCost: num(col("平均取得価額")),
        price: num(col("現在値")),
        priceUnit: (col("［単位］", 2) ?? "").trim(),
        change: num(col("前日比")),
        valueJpy: num(col("時価評価額[円]")),
        valueFx: num(col("時価評価額[外貨]")),
        plJpy: num(col("評価損益[円]")),
        plPct: num(col("評価損益[％]")),
      });
    } else if (section.startsWith("■参考為替")) {
      const rate = num(cells[1]);
      const m = /円\/([A-Z]{3})/.exec(cells[2] ?? "");
      if (rate !== null && m) fx[m[1]] = rate;
    }
  }
  const usdRow = holdings.find((h) => h.kind === "外貨預り金" && /米ドル|USD/.test(h.name));
  const cashJpy = summary["預り金"] ?? null;
  const marginDeposit = summary["国内株式信用保証金"] ?? null;
  return {
    asOf: opts.asOf ?? today(),
    summary, holdings, fx,
    totalValue: summary["資産合計"] ?? null,
    cashJpy, marginDeposit,
    buyingPower: (cashJpy ?? 0) + (marginDeposit ?? 0),
    cashUsd: usdRow?.qty ?? null,
    fxUsdJpy: fx.USD ?? usdRow?.price ?? null,
  };
}

const BEGIN = "<!-- kb:portfolio:begin -->";
const END = "<!-- kb:portfolio:end -->";
const fmt = (n: number | null, digits = 0) => n === null ? "-" : n.toLocaleString("ja-JP", { maximumFractionDigits: digits });
const signed = (n: number | null, digits = 0) => n === null ? "-" : (n > 0 ? "+" : "") + fmt(n, digits);

/** Markdown tables for the generated part of a portfolio note. Amounts use thousands separators (also keeps the long-digit-run check quiet). */
export function renderPortfolioSections(p: Portfolio): string {
  const by = (kind: string) => p.holdings.filter((h) => h.kind === kind);
  const stockRows = (hs: Holding[]) => hs.length
    ? hs.map((h) => `| ${h.code} | ${h.name} | ${h.account} | ${fmt(h.qty, 4)} | ${fmt(h.avgCost, 2)} | ${fmt(h.price, 2)} | ${signed(h.change, 2)} | ${fmt(h.valueJpy)} | ${signed(h.plJpy)} | ${signed(h.plPct, 2)} |`)
    : ["| - | （なし） | | | | | | | | |"];
  const fundRows = (hs: Holding[]) => hs.length
    ? hs.map((h) => `| ${h.name} | ${h.account} | ${fmt(h.qty)} | ${fmt(h.avgCost)} | ${fmt(h.price)} | ${fmt(h.valueJpy)} | ${signed(h.plJpy)} | ${signed(h.plPct, 2)} |`)
    : ["| （なし） | | | | | | | |"];
  const sum = (hs: Holding[]) => hs.reduce((a, h) => a + (h.valueJpy ?? 0), 0);
  const jp = by("国内株式"), us = by("米国株式"), funds = by("投資信託");
  const lines = [
    BEGIN,
    `_${p.asOf} 時点（楽天証券 資産残高 CSV から自動生成。この区間は \`kb portfolio import\` が書き換える）_`, "",
    "## 概況", "",
    `- 資産合計: ¥${fmt(p.totalValue)}`,
    `- 国内株式: ¥${fmt(sum(jp))}（${jp.length} 銘柄） / 米国株式: ¥${fmt(sum(us))}（${us.length} 銘柄） / 投資信託: ¥${fmt(sum(funds))}`,
    `- 現物買付余力: ¥${fmt(p.buyingPower)}（預り金 ¥${fmt(p.cashJpy)} + 信用保証金 ¥${fmt(p.marginDeposit)}）`,
    `- 外貨預り金: ${fmt(p.cashUsd, 2)} USD（USD/JPY ${fmt(p.fxUsdJpy, 2)}）`, "",
    "## 国内株式", "",
    "| コード | 銘柄 | 口座 | 数量 | 取得単価 | 現在値 | 前日比 | 評価額[円] | 損益[円] | 損益% |", "|---|---|---|---|---|---|---|---|---|---|",
    ...stockRows(jp), "",
    "## 米国株式", "",
    "| ティッカー | 銘柄 | 口座 | 数量 | 取得単価[USD] | 現在値[USD] | 前日比 | 評価額[円] | 損益[円] | 損益% |", "|---|---|---|---|---|---|---|---|---|---|",
    ...stockRows(us), "",
    "## 投資信託", "",
    "| 銘柄 | 口座 | 口数 | 取得単価 | 基準価額 | 評価額[円] | 損益[円] | 損益% |", "|---|---|---|---|---|---|---|---|",
    ...fundRows(funds), "",
    END,
  ];
  return lines.join("\n");
}

export interface ImportPortfolioOpts {
  /** CSV path, or a Bronze ID whose files include the CSV. */
  src: string;
  account: string;
}
export interface ImportPortfolioResult { path: string; created: boolean; asOf: string; positions: number; bronzeId: string | null }

const BRONZE_ID = /^\d{8}-[a-z]+-[0-9a-f]{6}$/;

/** Create or refresh the `portfolio` note for an account from a 楽天証券 asset CSV. Only the marked block and the numeric frontmatter change; `## 方針・メモ` is kept. */
export function importPortfolio(cfg: KbConfig, reg: SchemaRegistry, db: Database, o: ImportPortfolioOpts): ImportPortfolioResult {
  let abs = o.src, name = basename(o.src), bronzeId: string | null = null;
  if (BRONZE_ID.test(o.src)) {
    const meta = readMeta(cfg, o.src);
    if (!meta) throw new Error(`no Bronze item ${o.src}`);
    const f = meta.files.find((x) => /\.csv$/i.test(x)) ?? meta.files[0];
    if (!f) throw new Error(`Bronze ${o.src} has no files`);
    abs = join(bronzeDir(cfg, o.src), f);
    name = meta.source || f;
    bronzeId = o.src;
  }
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  const p = parseRakutenAssetCsv(decodeText(readFileSync(abs)), { asOf: asOfFromName(name) });
  if (!p.holdings.length && p.totalValue === null) throw new Error(`not a 楽天証券 asset CSV: ${name}`);

  const def = reg.get("portfolio");
  if (!def) throw new Error("schema portfolio.json missing");
  const existing = runQuery(db, { filters: [{ field: "type", op: "=", value: "portfolio" }, { field: "account", op: "=", value: o.account }] })[0];
  let rel = existing?.path, created = false;
  if (!rel) {
    rel = createNote(cfg, reg, db, { type: "portfolio", title: `${o.account} ポートフォリオ`, set: { account: o.account } });
    created = true;
  }
  const noteAbs = join(cfg.root, rel);
  const { fm, body } = parseNote(readFileSync(noteAbs, "utf8"));
  const block = renderPortfolioSections(p);
  const b = body.indexOf(BEGIN), e = body.indexOf(END);
  let newBody: string;
  if (b !== -1 && e !== -1 && e > b) newBody = body.slice(0, b) + block + body.slice(e + END.length);
  else {
    const h1 = /^# .*\n/m.exec(body);
    const at = h1 ? h1.index + h1[0].length : 0;
    newBody = body.slice(0, at) + "\n" + block + "\n" + body.slice(at);
  }
  const stocks = p.holdings.filter((h) => h.kind === "国内株式" || h.kind === "米国株式");
  Object.assign(fm, {
    account: o.account,
    as_of: p.asOf,
    total_value: p.totalValue,
    buying_power: p.buyingPower,
    cash_jpy: p.cashJpy,
    margin_deposit: p.marginDeposit,
    cash_usd: p.cashUsd,
    fx_usdjpy: p.fxUsdJpy,
    positions: stocks.length,
    summary: `${o.account}の保有資産（${p.asOf} 時点: 国内株 ${p.holdings.filter((h) => h.kind === "国内株式").length}・米国株 ${p.holdings.filter((h) => h.kind === "米国株式").length}・投信 ${p.holdings.filter((h) => h.kind === "投資信託").length}）`,
    updated: today(),
  });
  for (const k of ["total_value", "cash_jpy", "margin_deposit", "cash_usd", "fx_usdjpy"]) if (fm[k] === null) delete fm[k];
  const sources = new Set<string>(Array.isArray(fm.sources) ? fm.sources.map(String) : []);
  if (bronzeId) sources.add(bronzeId);
  fm.sources = [...sources];
  const related = new Set<string>(Array.isArray(fm.related) ? fm.related.map(String) : []);
  if (existsSync(join(cfg.root, def.folder, `${o.account}.md`))) related.add(`${o.account}.md`);
  fm.related = [...related];
  writeFileSync(noteAbs, stringifyNote(fm, newBody));
  if (bronzeId) markProcessed(cfg, bronzeId, [rel]);
  return { path: rel, created, asOf: p.asOf, positions: stocks.length, bronzeId };
}
