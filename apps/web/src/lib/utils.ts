import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Same as formatMoney / formatTotals in packages/core/src/money.ts: ¥1,280 / $8.25; currencies are never summed together. */
export function formatMoney(amount: number, currency = "JPY"): string {
  if (currency === "JPY") return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
  const n = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency === "USD" ? `$${n}` : `${currency} ${n}`;
}
export const formatTotals = (totals: { currency: string; amount: number }[]) =>
  totals.length ? totals.map((t) => formatMoney(t.amount, t.currency)).join(" + ") : formatMoney(0);
