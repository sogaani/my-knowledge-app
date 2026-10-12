import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { SchemaRegistry } from "./schema";
import { indexNotes, openDb } from "./db";
import { guessKind, ingestFile, readMeta } from "./bronze";
import { importHealth } from "./health";
import { parseNote } from "./frontmatter";
import type { HealthDay } from "./collect/sources/health";

function kb() {
  const root = mkdtempSync(join(tmpdir(), "kb-health-"));
  const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  w("AGENTS.md", "#");
  w("900_system/schemas/_common.json", JSON.stringify({ $id: "kb:common", type: "object", required: ["type", "title", "status", "created", "updated"] }));
  w("900_system/schemas/health_log.json", JSON.stringify({
    $id: "kb:health_log", "x-kb": { folder: "200_silver/210_health", entity: "file" }, allOf: [{ $ref: "kb:common" }],
    properties: { type: { const: "health_log" }, status: { enum: ["open", "closed"] }, month: { type: "string" } },
  }));
  w("800_templates/health_log.md", "---\ntype: health_log\ntitle: \"{{title}}\"\nstatus: open\ntags: []\ncreated: {{today}}\nupdated: {{today}}\nsources: []\nrelated: []\nsummary: \"\"\nmonth: \"\"\n---\n\n# {{title}}\n\n## 日別\n\n## メモ\n");
  mkdirSync(join(root, "200_silver", "210_health"), { recursive: true });
  mkdirSync(join(root, "000_inbox"), { recursive: true });
  process.env.KB_DB = join(root, "kb.sqlite");
  const cfg = loadConfig(root);
  delete process.env.KB_DB;
  return { root, cfg, reg: new SchemaRegistry(cfg) };
}

const d = (date: string, steps: string, sleep?: string): HealthDay => ({
  date,
  rollups: { steps: { civilStartTime: { date: { year: 2026, month: Number(date.slice(5, 7)), day: Number(date.slice(8)) } }, civilEndTime: { date: { year: 2026, month: 1, day: 1 } }, steps: { countSum: steps } } },
  sleep: sleep ? [{ sleep: { interval: { startTime: "", endTime: "" }, summary: { minutesAsleep: sleep } } }] : [],
});

function feedToBronze(cfg: ReturnType<typeof kb>["cfg"], name: string, items: HealthDay[]) {
  const p = join(cfg.inbox, name);
  writeFileSync(p, JSON.stringify({ source: "health", from: items[0]!.date, to: "x", collected_at: "", count: items.length, items }));
  return ingestFile(cfg, p);
}

describe("collector files in Bronze", () => {
  test("kinds", () => {
    expect(guessKind("/i/collect-health-2026-10-01_2026-10-08.json")).toBe("feed");
    expect(guessKind("/i/mail-20261011-purchase-18f0.json")).toBe("mail");
    expect(guessKind("/i/other.json")).toBe("file");
  });
});

describe("importHealth", () => {
  test("builds monthly notes, later captures win per day, the memo section survives", async () => {
    const { cfg, reg } = kb();
    const a = feedToBronze(cfg, "collect-health-2026-09-29_2026-10-02.json", [d("2026-09-30", "5000", "420"), d("2026-10-01", "7000")]);
    await Bun.sleep(5); // distinct captured_at
    const b = feedToBronze(cfg, "collect-health-2026-10-01_2026-10-03.json", [d("2026-10-01", "9000", "360"), d("2026-10-02", "11000", "400")]);
    expect(a.kind).toBe("feed");

    const db = openDb(cfg);
    indexNotes(cfg, db);
    const r1 = importHealth(cfg, reg, db, a.id);
    expect(r1.months.map((m) => [m.path.split("/").pop(), m.created])).toEqual([["2026-09.md", true], ["2026-10.md", true]]);

    indexNotes(cfg, db);
    const oct = join(cfg.root, r1.months[1]!.path);
    writeFileSync(oct, readFileSync(oct, "utf8").replace("## メモ\n", "## メモ\n\n- 風邪で寝ていた\n"));
    const r2 = importHealth(cfg, reg, db, b.id);
    expect(r2.months).toEqual([{ path: r1.months[1]!.path, created: false, days: 2 }]);

    const { fm, body } = parseNote(readFileSync(oct, "utf8"));
    expect(body).toContain("| 2026-10-01 | 9,000 | 6h00m |"); // b overwrote a's 10-01
    expect(body).toContain("| 2026-10-02 | 11,000 | 6h40m |");
    expect(body.match(/kb:health:start/g)?.length).toBe(1);
    expect(body).toContain("- 風邪で寝ていた");
    expect(fm).toMatchObject({ month: "2026-10", days: 2, avg_steps: 10000, avg_sleep_min: 380 });
    expect(String(fm.summary)).toStartWith("2026年10月の健康記録");
    expect([...(fm.sources as string[])].sort()).toEqual([a.id, b.id].sort());
    expect(readMeta(cfg, b.id)!.processed_to).toEqual([r1.months[1]!.path]);
  });
});
