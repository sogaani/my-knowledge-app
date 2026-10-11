import { describe, expect, test } from "bun:test";
import { asOfFromName, decodeText, parseCsvLine, parseRakutenAssetCsv, renderPortfolioSections } from "./portfolio";

// Synthetic fixture in the real export's shape (fake tickers and amounts; never real account data).
const CSV = [
  '"■資産合計欄"',
  '"","時価評価額[円]","前日比[円]","前日比[％]"',
  '"資産合計","12,345,678","-1,000","-0.01"',
  '',
  '"保有商品の評価額合計","11,000,000","0","0.00"',
  '"国内株式","1,500,000","0","0.00"',
  '"預り金合計","1,345,678","+24","0.00"',
  '"預り金","100,000","0","0.00"',
  '"外貨預り金","16,241","+24","+0.15"',
  '"国内株式信用保証金","1,229,437","0","0.00"',
  '"楽天銀行普通預金残高","未取得"',
  '',
  '"■ 保有商品詳細 (すべて）"',
  '',
  '"種別","銘柄コード・ティッカー","銘柄","口座","保有数量","［単位］","平均取得価額","［単位］","現在値","［単位］","現在値(更新日)","(参考為替)","前日比","［単位］","時価評価額[円]","時価評価額[外貨]","評価損益[円]","評価損益[％]"',
  '"国内株式","9999","テ　ス　ト","特定","1,000","株","1,234.50","円","1,500.0","円","","","+15.0","円","1,500,000","-","+265,500","+21.51"',
  '"国内株式","9998","ＮＩＳＡ株","NISA成長投資枠","12.34567891","株","10,000.00","円","9,000.0","円","","","-10.0","円","111,111","-","-12,345","-10.00"',
  '"米国株式","ZZZZ","Example Inc","特定","10","株","100.00","USD","120.00","USD","","158.00","+1.00","USD","189,600","1,200.00","+31,600","+20.00"',
  '"投資信託","","テスト・インデックス・ファンド","NISAつみたて投資枠","960,024","口","33,853.32","円","45,246","円","","","-148","円","4,343,725","-","+1,093,725","+33.65"',
  '"外貨預り金","","米ドル","-","102.59","USD","-","-","158.31","円/USD","","","-","-","16,241.00","-","-","-"',
  '',
  '"■参考為替レート"',
  '',
  '"米ドル","158.31","円/USD","(10/10  05:59)"',
  '"ユーロ","177.36","円/EUR","(10/10  06:55)"',
].join("\r\n");

describe("decodeText", () => {
  test("falls back to Shift_JIS when bytes are not UTF-8", () => {
    expect(decodeText(new Uint8Array([0x93, 0xfa, 0x96, 0x7b]))).toBe("日本");
  });
  test("keeps UTF-8 and strips a BOM", () => {
    expect(decodeText(new TextEncoder().encode("﻿あ,1"))).toBe("あ,1");
  });
});

describe("parseCsvLine", () => {
  test("handles quoted thousands separators and CRLF", () => {
    expect(parseCsvLine('"a","1,234","x""y"\r')).toEqual(["a", "1,234", 'x"y']);
  });
});

describe("parseRakutenAssetCsv", () => {
  const p = parseRakutenAssetCsv(CSV, { asOf: "2026-10-11" });
  test("summary numbers", () => {
    expect(p.totalValue).toBe(12345678);
    expect(p.cashJpy).toBe(100000);
    expect(p.marginDeposit).toBe(1229437);
    expect(p.buyingPower).toBe(1329437);
    expect(p.summary["楽天銀行普通預金残高"]).toBeNull();
  });
  test("holdings by header name, full-width spaces normalized", () => {
    const jp = p.holdings.filter((h) => h.kind === "国内株式");
    expect(jp.map((h) => h.name)).toEqual(["テスト", "NISA株"]);
    expect(jp[0]).toMatchObject({ code: "9999", account: "特定", qty: 1000, avgCost: 1234.5, price: 1500, change: 15, valueJpy: 1500000, plJpy: 265500, plPct: 21.51 });
    expect(p.holdings.find((h) => h.kind === "米国株式")).toMatchObject({ code: "ZZZZ", priceUnit: "USD", valueFx: 1200 });
    expect(p.holdings.find((h) => h.kind === "投資信託")?.qty).toBe(960024);
  });
  test("cash in USD and fx", () => {
    expect(p.cashUsd).toBe(102.59);
    expect(p.fxUsdJpy).toBe(158.31);
    expect(p.fx.EUR).toBe(177.36);
  });
  test("as_of from filename", () => {
    expect(asOfFromName("assetbalance(all)_20261011_191128.csv")).toBe("2026-10-11");
    expect(asOfFromName("holdings.csv")).toBeNull();
  });
  test("rendered block has no 7+ digit runs and keeps markers", () => {
    const md = renderPortfolioSections(p);
    expect(md.startsWith("<!-- kb:portfolio:begin -->")).toBe(true);
    expect(md.trimEnd().endsWith("<!-- kb:portfolio:end -->")).toBe(true);
    expect(/(^|[^0-9-])[0-9]{7,}([^0-9-]|$)/.test(md)).toBe(false);
    expect(md).toContain("| 9999 | テスト | 特定 | 1,000 |");
  });
});
