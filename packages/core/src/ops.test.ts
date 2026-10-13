import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastBackupAt } from "./backup";
import { loadConfig } from "./config";
import { buildOpsDigest, clipError, countInbox, countNoteChanges, errorHead, extractJudgements, formatOpsDigest, renderOpsDigest, summarizeCollect } from "./ops";

const CF_502 = `<!DOCTYPE html><html><head><title>kb.example | 502: Bad gateway</title><style>body{margin:0}</style>
<script>window.x=1</script></head><body><div id="cf-wrapper"><h1><span class="cf-error-type">Error</span><span>502</span></h1>
<h2>Bad gateway</h2><p>${"The web server reported a bad gateway error. ".repeat(20)}</p></div></body></html>`;

describe("clipError / errorHead", () => {
  test("strips HTML, scripts and styles, collapses whitespace and cuts at 200", () => {
    const s = clipError(CF_502);
    expect(s).not.toContain("<");
    expect(s).not.toContain("window.x");
    expect(s).not.toContain("margin");
    expect(s.startsWith("kb.example | 502: Bad gateway Error 502 Bad gateway")).toBe(true);
    expect(s.length).toBe(201); // 200 + ellipsis
    expect(s.endsWith("…")).toBe(true);
  });
  test("short plain text is returned as is", () => {
    expect(clipError("  boom\n  twice ")).toBe("boom twice");
  });
  test("errorHead prefers error, then summary, then JSON", () => {
    expect(errorHead({ error: "kb build: exit 1" })).toBe("kb build: exit 1");
    expect(errorHead({ summary: "x".repeat(300) }).length).toBe(141);
    expect(errorHead({ foo: 1 })).toBe('{"foo":1}');
    expect(errorHead(null)).toBe("");
  });
});

describe("summarizeCollect", () => {
  const now = new Date("2026-10-13T22:00:00Z");
  test("ok / failed / stale by lastError and age, sorted by id, with item counts", () => {
    const r = summarizeCollect({
      youtube: { lastRunAt: "2026-10-13T21:30:00Z", lastItems: 3, lastTo: "x" },
      gmail: { lastRunAt: "2026-10-13T21:30:00Z", lastError: "HTTP 401 invalid_grant: run bun run collect auth" },
      health: { lastRunAt: "2026-10-10T22:00:00Z", lastItems: 7 },
      linkedin: {},
    }, now);
    expect(r.map((s) => [s.id, s.status, s.items])).toEqual([["gmail", "failed", 0], ["health", "stale", 7], ["linkedin", "stale", 0], ["youtube", "ok", 3]]);
    expect(r[0]!.error).toContain("invalid_grant");
    expect(r[1]!.ageHours).toBe(72);
    expect(r[2]!.ageHours).toBeUndefined();
  });
});

describe("countInbox / countNoteChanges", () => {
  test("feeds, mails and the rest", () => {
    expect(countInbox(["collect-github-2026-10-12_2026-10-13.json", "collect-health-2026-10-12_2026-10-13.json", "mail-20261013-purchase-abc.json", "url-1234.md", "memo.md"]))
      .toEqual({ feeds: 2, mails: 1, other: 2 });
  });
  test("only Silver .md count; untracked and added are created, modified are updated", () => {
    expect(countNoteChanges([
      { status: "??", path: "200_silver/201_learning/新しいノート.md" },
      { status: "A ", path: "200_silver/206_projects/x/README.md" },
      { status: " M", path: "200_silver/206_projects/x/log.md" },
      { status: "M ", path: "200_silver/204_books/a.md" },
      { status: " M", path: "300_gold/300_home.md" },
      { status: "??", path: "200_silver/204_books/cover.png" },
      { status: " D", path: "200_silver/204_books/old.md" },
    ])).toEqual({ created: 2, updated: 2 });
  });
});

describe("extractJudgements", () => {
  test("bold heading followed by bullets, stops at the first non-bullet line", () => {
    const out = "作成したノート:\n- 200_silver/201_learning/a.md\n\n**判断に迷った点**\n- 監督が分からなかったので空のままにした\n- 評価は付けていない\n\n以上です。\n- これは別の箇条書き\n";
    expect(extractJudgements(out)).toEqual(["監督が分からなかったので空のままにした", "評価は付けていない"]);
  });
  test("sentence heading and numbered bullets", () => {
    const out = "判断に迷った点が 2 つあります。\n1. learning に分類した\n2) 新規作成にした\nメモは読めなかった。\n";
    expect(extractJudgements(out)).toEqual(["learning に分類した", "新規作成にした"]);
  });
  test("inline form and 'none' answers", () => {
    expect(extractJudgements("- 判断に迷った点: 重複の可能性あり\n")).toEqual(["重複の可能性あり"]);
    expect(extractJudgements("判断に迷った点: 特になし\n")).toEqual([]);
    expect(extractJudgements("何もありません\n")).toEqual([]);
  });
});

describe("buildOpsDigest / format", () => {
  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "kb-ops-"));
    const w = (rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
    w("AGENTS.md", "");
    w("900_system/cache/collect-state.json", JSON.stringify({
      github: { lastRunAt: "2026-10-13T21:30:00Z", lastItems: 4, lastTo: "2026-10-13T21:30:00Z", cursor: "c" },
      gmail: { lastRunAt: "2026-10-13T21:30:00Z", lastItems: 12 },
      youtube: { lastRunAt: "2026-10-13T21:30:00Z", lastError: "HTTP 403 quota" },
    }));
    // Bronze: one processed, one `-`, one unprocessed (fixture only: generic kinds, nothing from an encrypted domain)
    const meta = (id: string, processed: string[]) => w(`100_bronze/2026/10/${id}/meta.json`, JSON.stringify({ id, kind: "web", source: "https://example.com", captured_at: "2026-10-13T00:00:00Z", files: ["page.html"], processed_to: processed }));
    meta("20261013-web-000001", ["200_silver/201_learning/a.md"]);
    meta("20261013-web-000002", ["-"]);
    meta("20261013-web-000003", []);
    w("900_system/logs/backup.log", "[2026-10-09T21:00:00.000Z] DRY -> /Volumes/Backup/kb\nstats\n[2026-10-10T21:00:00.000Z] -> /Volumes/Backup/kb\nstats\n");
    return root;
  }

  test("combines collector state, inbox, git changes, judgements, Bronze backlog and backup age", () => {
    const cfg = loadConfig(fixtureRoot());
    const d = buildOpsDigest(cfg, {
      now: new Date(2026, 9, 14, 7, 5),
      inboxNames: ["collect-github-2026-10-13_2026-10-14.json", "mail-20261014-purchase-a.json", "mail-20261014-purchase-b.json"],
      agentOutput: "done\n\n**判断に迷った点**\n- 二重計上の可能性があるので台帳には追記しなかった\n",
      agentOk: true,
      changes: [{ status: "??", path: "200_silver/201_learning/b.md" }, { status: " M", path: "200_silver/206_projects/p/log.md" }],
    });
    expect(d.date).toBe("2026-10-14");
    expect(d.collect.map((s) => `${s.id}:${s.status}`)).toEqual(["github:ok", "gmail:ok", "youtube:failed"]);
    expect(d.inbox).toEqual({ feeds: 1, mails: 2, other: 0 });
    expect(d.notes).toEqual({ created: 1, updated: 1 });
    expect(d.judgements).toEqual(["二重計上の可能性があるので台帳には追記しなかった"]);
    expect(d.unprocessedBronze).toBe(1);
    expect(d.backupDays).toBe(3); // the DRY line does not count

    const push = formatOpsDigest(d);
    expect(push.title).toBe("運用ダイジェスト 10/14");
    expect(push.body.split("\n")).toEqual([
      "収集: github 4 · gmail 12 · youtube 失敗",
      "ノート: 新規 1 / 更新 1 · 未処理 Bronze 1 · バックアップ 3 日前",
      "迷った点 1: 二重計上の可能性があるので台帳には追記しなかった",
    ]);
    const text = renderOpsDigest(d);
    expect(text).toContain("youtube: HTTP 403 quota");
    expect(text).toContain("inbox: feed 1 / mail 2 / その他 0");
    expect(text).toContain("- 二重計上の可能性");
  });

  test("no backup log, no state, failed agent", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-ops-"));
    writeFileSync(join(root, "AGENTS.md"), "");
    const cfg = loadConfig(root);
    expect(lastBackupAt(cfg)).toBeNull();
    const d = buildOpsDigest(cfg, { now: new Date(2026, 0, 2), inboxNames: [], agentOutput: "", agentOk: false, changes: [] });
    expect(d.backupDays).toBeNull();
    expect(d.collect).toEqual([]);
    const push = formatOpsDigest(d);
    expect(push.title).toBe("[失敗] 運用ダイジェスト 1/2");
    expect(push.body).toBe("収集: 記録なし\nノート: 新規 0 / 更新 0 · 未処理 Bronze 0 · バックアップ 未実施");
  });
});
