import { describe, expect, test } from "bun:test";
import { currencyOf, formatMoney, formatTotals, monthlyByCurrency } from "./money";

describe("money", () => {
  test("yen and dollars are totalled separately", () => {
    const totals = monthlyByCurrency([
      { fm: { price: 1000, cycle: "monthly" } }, // no currency = JPY
      { fm: { price: 12000, cycle: "yearly", currency: "JPY" } },
      { fm: { price: 20, cycle: "monthly", currency: "USD" } },
      { fm: { price: 99, cycle: "yearly", currency: "usd" } },
      { fm: { price: 0, cycle: "monthly", currency: "EUR" } },
    ]);
    expect(totals).toEqual([{ currency: "JPY", amount: 2000 }, { currency: "USD", amount: 28.25 }]);
    expect(formatTotals(totals)).toBe("¥2,000 + $28.25");
    expect(formatTotals(totals, 12)).toBe("¥24,000 + $339");
    expect(formatTotals([])).toBe("¥0");
  });
  test("formatting", () => {
    expect(currencyOf({ currency: " usd " })).toBe("USD");
    expect(formatMoney(1280.4)).toBe("¥1,280");
    expect(formatMoney(8.25, "USD")).toBe("$8.25");
    expect(formatMoney(12.5, "EUR")).toBe("EUR 12.5");
  });
});
