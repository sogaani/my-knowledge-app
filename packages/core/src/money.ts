/**
 * Prices in frontmatter: `price` in `currency` (ISO code, default JPY), e.g. subscriptions.
 * Amounts in different currencies are never added together: totals are kept per currency.
 * apps/web/src/lib/utils.ts has the same formatter (the web bundle does not import @kb/core).
 */
type Fm = Record<string, unknown>;

export const currencyOf = (fm: Fm): string => String(fm.currency ?? "").trim().toUpperCase() || "JPY";

/** Monthly amount of a subscription (yearly / 12), in its own currency. */
export function toMonthly(fm: Fm): number {
  const p = Number(fm.price ?? 0);
  if (!Number.isFinite(p)) return 0;
  return fm.cycle === "yearly" ? p / 12 : p;
}

export interface MoneyTotal { currency: string; amount: number }

/** Monthly totals per currency, JPY first. */
export function monthlyByCurrency(items: { fm: Fm }[]): MoneyTotal[] {
  const sums = new Map<string, number>();
  for (const { fm } of items) {
    const m = toMonthly(fm);
    if (m) sums.set(currencyOf(fm), (sums.get(currencyOf(fm)) ?? 0) + m);
  }
  return [...sums].map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => (a.currency === "JPY" ? -1 : b.currency === "JPY" ? 1 : a.currency.localeCompare(b.currency)));
}

/** ¥1,280 / $8.25 / EUR 12.5 (yen rounded, others up to 2 decimals). */
export function formatMoney(amount: number, currency = "JPY"): string {
  if (currency === "JPY") return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
  const n = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency === "USD" ? `$${n}` : `${currency} ${n}`;
}

/** "¥1,280 + $8.25" (scaled by `factor`, e.g. 12 for a yearly figure); "¥0" when empty. */
export function formatTotals(totals: MoneyTotal[], factor = 1): string {
  return totals.length ? totals.map((t) => formatMoney(t.amount * factor, t.currency)).join(" + ") : formatMoney(0);
}
