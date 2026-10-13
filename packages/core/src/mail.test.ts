import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { indexNotes, openDb } from "./db";
import { ingestFile, readMeta } from "./bronze";
import { compileRules, extractAmount, extractDate, extractItem, extractMerchant, formatMailImport, importMail, loadMailRules, matchLedger, matchRoutine, readMail, MAIL_RULES_REL, type MailRules } from "./mail";
import { ledgerRows, ledgerSpending } from "./views";

// Every mail, shop and amount below is made up.

const RULES: MailRules = {
  version: 1,
  routine: [
    { name: "login notice", subject: "ログイン", categories: ["finance"] },
    { name: "security", subject: "(認証|セキュリティ|パスワード)" },
    { name: "shipping", subject: "(発送|出荷)", unless: "(お支払い|金額|決済)", categories: ["purchase"] },
    { name: "newsletter sender", from: "news@" },
  ],
};

function kb() {
  const root = mkdtempSync(join(tmpdir(), "kb-mail-"));
  const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  w("AGENTS.md", "#");
  mkdirSync(join(root, "200_silver", "203_finance"), { recursive: true });
  mkdirSync(join(root, "000_inbox"), { recursive: true });
  mkdirSync(join(root, "900_system", "schemas"), { recursive: true });
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  return { root, cfg, w };
}

const mailJson = (over: Partial<{ subject: string; from: string; date: string; body: string; category: string; gmail_id: string }>) => ({
  source: "gmail", gmail_id: over.gmail_id ?? "abc123", gmail_thread: "t", gmail_label: "KB/購入", category: over.category ?? "purchase",
  date: over.date ?? "2026-10-05T03:00:00Z", from: over.from ?? "shop@example.test", to: "me@example.test", subject: over.subject ?? "",
  attachments: [], body: over.body ?? "", body_truncated: false, snippet: "", label_ids: [], headers: [],
});

function drop(cfg: ReturnType<typeof kb>["cfg"], name: string, json: unknown) {
  const p = join(cfg.inbox, name);
  writeFileSync(p, JSON.stringify(json));
  return ingestFile(cfg, p);
}

describe("mail rules", () => {
  const rules = compileRules(RULES);
  test("subject / from / category / unless", () => {
    expect(matchRoutine({ subject: "お取引画面にログインがありました", from: "a@bank.test", category: "finance" }, rules)?.name).toBe("login notice");
    expect(matchRoutine({ subject: "ログインのお知らせ", from: "a@shop.test", category: "purchase" }, rules)).toBeNull(); // category-limited
    expect(matchRoutine({ subject: "パスワード変更完了", from: "a@x.test", category: "finance" }, rules)?.name).toBe("security");
    expect(matchRoutine({ subject: "商品を発送しました", from: "a@shop.test", category: "purchase" }, rules)?.name).toBe("shipping");
    expect(matchRoutine({ subject: "発送とお支払いのご案内", from: "a@shop.test", category: "purchase" }, rules)).toBeNull(); // unless
    expect(matchRoutine({ subject: "今週のおすすめ", from: "News <news@shop.test>", category: "purchase" }, rules)?.name).toBe("newsletter sender");
    expect(matchRoutine({ subject: "ご注文ありがとうございます", from: "a@shop.test", category: "purchase" }, rules)).toBeNull();
  });
  test("bad patterns and nameless rules are rejected", () => {
    expect(() => compileRules({ routine: [{ name: "x", subject: "(" }] })).toThrow(/bad subject pattern/);
    expect(() => compileRules({ routine: [{ name: "", subject: "a" }] })).toThrow(/without a name/);
    expect(() => compileRules({ routine: [{ name: "x" }] })).toThrow(/needs subject or from/);
  });
  test("missing file means no rules", () => {
    const { cfg } = kb();
    expect(loadMailRules(cfg)).toMatchObject({ exists: false, rules: { routine: [] } });
  });
});

describe("amount / date / merchant extraction", () => {
  test("prefers the total line, ignores discounts, falls back to the largest amount", () => {
    expect(extractAmount("小計 1,200円\n送料 500円\nポイント利用 -200円\n合計 1,500円\n")).toEqual({ amount: 1500, currency: "JPY" });
    expect(extractAmount("ご利用金額：￥３，９８０\n")).toEqual({ amount: 3980, currency: "JPY" }); // full-width
    expect(extractAmount("A 300円 / B 2,000円 / C 50円")).toEqual({ amount: 2000, currency: "JPY" });
    expect(extractAmount("Total: $12.34\n")).toEqual({ amount: 12.34, currency: "USD" });
    expect(extractAmount("2026年10月3日 ご注文ありがとうございます")).toBeNull();
    expect(extractAmount("金額 0円")).toBeNull();
  });
  test("flattened tables, bare figures on amount lines, JPY suffix; ids, dates and counts are not amounts", () => {
    expect(extractAmount("商品 A 1,200円\nお支払い金額\n1,300\n（税込）")).toEqual({ amount: 1300, currency: "JPY" }); // figure on the line after the keyword
    expect(extractAmount("ご請求金額 2,980")).toEqual({ amount: 2980, currency: "JPY" }); // bare figure on a keyword line
    expect(extractAmount("Amount: 4,500 JPY")).toEqual({ amount: 4500, currency: "JPY" });
    expect(extractAmount("ご利用金額確認番号 123456\n注文番号 98765")).toBeNull(); // ids
    expect(extractAmount("金額は 2026/10/03 12:30 に確定します")).toBeNull(); // date / time
    expect(extractAmount("数量 3 個 / 金額 980円")).toEqual({ amount: 980, currency: "JPY" });
    expect(extractAmount("ご注文番号 123456\n商品 1 点")).toBeNull();
  });
  test("unless_amount: a shipping notice that states the price is not routine", () => {
    const rules = compileRules({ routine: [{ name: "shipping", subject: "発送", unless_amount: true, categories: ["purchase"] }] });
    const mail = { subject: "商品を発送しました", from: "a@shop.test", category: "purchase" };
    expect(matchRoutine(mail, rules, () => false)?.name).toBe("shipping");
    expect(matchRoutine(mail, rules, () => true)).toBeNull();
    expect(matchRoutine(mail, rules)?.name).toBe("shipping"); // default: no amount known
  });
  test("the dated line naming the transaction wins over the mail date", () => {
    expect(extractDate("ご利用日：2026/10/03\nお引落日：2026/11/27", "2026-10-05T03:00:00Z")).toBe("2026-10-03");
    expect(extractDate("注文日時: 2026年10月4日 12:00", "2026-10-05T03:00:00Z")).toBe("2026-10-04");
    expect(extractDate("期限は 2026/12/31 までです", "2026-10-05T03:00:00Z")).toBe("2026-10-05"); // no transaction keyword
    expect(extractDate("", "2026-10-05T16:30:00Z")).toBe("2026-10-06"); // Asia/Tokyo day
  });
  test("merchant and item", () => {
    expect(extractMerchant("【架空堂】ご注文ありがとうございます", "a@kakudo.test")).toBe("架空堂");
    expect(extractMerchant("【重要】お知らせ", '"架空商店" <a@kakudo.test>')).toBe("架空商店");
    expect(extractMerchant("ご注文", "a@kakudo.test")).toBe("kakudo.test");
    expect(extractItem("ご注文内容\n商品名：架空のノート 3 冊セット\n数量: 1")).toBe("架空のノート 3 冊セット");
    expect(extractItem("本文に品目なし")).toBeNull();
  });
});

describe("ledger matching", () => {
  const body = "# 2026-10 家計\n\n## 明細\n\n| 日付 | 内容 | 金額 | 区分 | 支払手段 | 出典 |\n|---|---|---|---|---|---|\n| 2026-10-03 | 架空マート | 1500 | 食費 | 架空カード | moneytree |\n| 2026-10-04 | 給与 | 100000 | 収入 | 振込 | moneytree |\n| 2026-10-06 | 架空書房 | 2200 | 書籍 | 架空カード | 20261006-mail-aaaaaa |\n\n## メモ\n";
  const rows = ledgerRows(body).map((r) => ({ ...r, path: "200_silver/203_finance/2026-10.md" }));
  test("ledgerRows / ledgerSpending", () => {
    expect(rows.map((r) => [r.date, r.amount, r.source])).toEqual([["2026-10-03", 1500, "moneytree"], ["2026-10-04", 100000, "moneytree"], ["2026-10-06", 2200, "20261006-mail-aaaaaa"]]);
    expect(ledgerSpending(body).map((r) => r.amount)).toEqual([1500, 2200]);
  });
  test("recorded / matched (±1 day, Moneytree first) / unmatched", () => {
    expect(matchLedger({ id: "20261006-mail-aaaaaa", date: "2026-10-06", amount: 2200, currency: "JPY" }, rows).state).toBe("recorded");
    expect(matchLedger({ id: "x", date: "2026-10-04", amount: 1500, currency: "JPY" }, rows)).toMatchObject({ state: "matched", row: { source: "moneytree", date: "2026-10-03" } });
    expect(matchLedger({ id: "x", date: "2026-10-05", amount: 1500, currency: "JPY" }, rows).state).toBe("unmatched"); // 2 days off
    expect(matchLedger({ id: "x", date: "2026-10-03", amount: 1501, currency: "JPY" }, rows).state).toBe("unmatched");
    expect(matchLedger({ id: "x", date: "2026-10-03", amount: 1500, currency: "USD" }, rows).state).toBe("unmatched");
  });
});

describe("importMail", () => {
  test("routine → processed -, money mails → candidates matched against the ledger, the rest → manual", () => {
    const { cfg, w } = kb();
    w(MAIL_RULES_REL, JSON.stringify(RULES));
    w("200_silver/203_finance/2026-10.md", "---\ntype: ledger\ntitle: 2026-10 家計\nstatus: open\ntags: []\ncreated: 2026-10-01\nupdated: 2026-10-01\nsources: []\nrelated: []\nsummary: x\nmonth: \"2026-10\"\ntotal: 1500\n---\n\n# 2026-10 家計\n\n## 明細\n\n| 日付 | 内容 | 金額 | 区分 | 支払手段 | 出典 |\n|---|---|---|---|---|---|\n| 2026-10-03 | 架空マート | 1500 | 食費 | 架空カード | moneytree |\n");
    const login = drop(cfg, "mail-20261005-finance-m1.json", mailJson({ category: "finance", gmail_id: "m1", subject: "お取引画面にログインがありました", from: "a@bank.test" }));
    const order = drop(cfg, "mail-20261005-purchase-m2.json", mailJson({ gmail_id: "m2", subject: "【架空マート】ご注文ありがとうございます", from: '"架空マート" <a@kakumart.test>', body: "ご注文日: 2026/10/03\n商品名: 架空のりんご\n小計 1,400円\n送料 100円\n合計 1,500円" }));
    const later = drop(cfg, "mail-20261009-purchase-m3.json", mailJson({ gmail_id: "m3", date: "2026-10-09T01:00:00Z", subject: "ご注文確認", from: "b@kakushop.test", body: "お支払い金額 2,480円" }));
    const noAmount = drop(cfg, "mail-20261005-purchase-m4.json", mailJson({ gmail_id: "m4", subject: "ご注文ありがとうございます", body: "のちほど請求します" }));
    const work = drop(cfg, "mail-20261005-work-m5.json", mailJson({ category: "work", gmail_id: "m5", subject: "面談日程のご案内", body: "10月7日 14:00 でお願いします" }));
    const db = openDb(cfg);
    indexNotes(cfg, db);

    const dry = importMail(cfg, db, { all: true, dryRun: true });
    expect(dry.processed).toEqual([]);
    expect(readMeta(cfg, login.id)!.processed_to).toEqual([]);

    const r = importMail(cfg, db, { all: true });
    expect(r.rules).toMatchObject({ count: 4, exists: true });
    expect(r.moneytreeThrough).toBe("2026-10-03");
    expect(r.processed).toEqual([login.id]);
    expect(readMeta(cfg, login.id)!.processed_to).toEqual(["-"]);
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(by[login.id]).toMatchObject({ decision: "routine", rule: "login notice", category: "finance" });
    expect(by[order.id]).toMatchObject({ decision: "candidate", amount: 1500, currency: "JPY", txDate: "2026-10-03", merchant: "架空マート", item: "架空のりんご", match: "matched", ledger: { source: "moneytree", date: "2026-10-03" }, moneytreeCovered: true });
    expect(by[later.id]).toMatchObject({ decision: "candidate", amount: 2480, txDate: "2026-10-09", merchant: "kakushop.test", match: "unmatched", moneytreeCovered: false });
    expect(by[noAmount.id]).toMatchObject({ decision: "manual", reason: "no amount found" });
    expect(by[work.id]).toMatchObject({ decision: "manual" });
    expect(by[work.id]!.reason).toContain("category work");
    // output never carries bodies
    const text = formatMailImport(r);
    expect(text).toContain("routine 1 (marked processed: -) / candidates 2 / manual 2 / skipped 0");
    expect(text).toContain("¥1,500  架空マート / 架空のりんご  → matched (moneytree 2026-10-03)");
    expect(text).toContain("unmatched (moneytree not pulled for this day yet)");
    expect(text).not.toContain("架空のりんご\n小計");
    expect(text).not.toContain("のちほど請求します");

    // a second run: the routine one is processed now, explicit ids report why they are skipped
    const again = importMail(cfg, db, { ids: [login.id, "20260101-mail-nothere", order.id] });
    expect(again.skipped).toEqual([{ id: login.id, reason: "already processed (-)" }, { id: "20260101-mail-nothere", reason: "no such Bronze item" }]);
    expect(again.items.map((i) => i.id)).toEqual([order.id]);
  });

  test("the old Apps Script Markdown mail is read the same way", () => {
    const { cfg, w } = kb();
    w(MAIL_RULES_REL, JSON.stringify(RULES));
    const p = join(cfg.inbox, "mail-20260920-finance-old1.md");
    writeFileSync(p, '# ログインのお知らせ\n\n- from: "架空銀行" <no-reply@kakubank.test>\n- to: me@example.test\n- date: 2026-09-20T10:00:00+09:00\n- subject: ログインのお知らせ\n- gmail_id: old1\n- category: finance\n\n---\n\n本文\n');
    const meta = ingestFile(cfg, p);
    expect(meta.kind).toBe("mail");
    expect(readMail(cfg, meta)).toMatchObject({ category: "finance", subject: "ログインのお知らせ", from: '"架空銀行" <no-reply@kakubank.test>', date: "2026-09-20T10:00:00+09:00", gmail_id: "old1", body: "本文\n" });
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const r = importMail(cfg, db, { ids: [meta.id] });
    expect(r.items[0]).toMatchObject({ decision: "routine", rule: "login notice", date: "2026-09-20" });
    expect(r.moneytreeThrough).toBeNull();
  });
});
