#!/usr/bin/env bun
import { join } from "node:path";
import {
  loadConfig, openDb, indexNotes, loadSimilar, SchemaRegistry, createNote, DuplicateError, patchFrontmatter, appendToSection,
  ingestFile, ingestUrl, sourceExcerpt, markProcessed, listInbox, parseFilters, runQuery, buildGold,
  validateAll, archiveNote, lint, backupBronze, pruneBronze, logAccess, importPortfolio, importHealth, importLocation, importCalendar, importKoboLibrary, importMail, formatMailImport, runCollectors, type BronzeKind,
  search, VectorStore, embedNotes, makeEmbedder, setupLindera, linderaStatus, resolveTokenizer, readVectorMeta, type SearchMode,
  LAYOUT, curateArticles, buildHistory, listArticleDays, articleStats,
} from "@kb/core";

const argv = process.argv.slice(2);
const cmd = argv.shift();

function flags(args: string[]) {
  const f: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) f[k] = v;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--") && ["set", "dest", "kind", "text", "status", "superseded-by", "older-than", "type", "limit", "order", "chars", "title", "folder", "section", "fields", "mode", "account", "max-lookups", "date"].includes(k)) f[k] = args[++i];
      else f[k] = true;
    } else pos.push(a);
  }
  return { f, pos };
}
const die = (m: string): never => { console.error(`kb: ${m}`); process.exit(1); };
const json = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const parseSet = (s: string | boolean | undefined, acc: Record<string, unknown> = {}) => {
  if (typeof s !== "string") return acc;
  const [k, ...v] = s.split("=");
  const raw = v.join("=");
  acc[k] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw.startsWith("[") ? JSON.parse(raw) : raw;
  return acc;
};
const collectSets = (args: string[]) => {
  const acc: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) if (args[i] === "--set" && args[i + 1]) parseSet(args[++i], acc);
  return acc;
};

const cfg = loadConfig();
const reg = new SchemaRegistry(cfg);
const db = () => { const d = openDb(cfg); indexNotes(cfg, d); return d; };
const warn = (m: string) => console.error(m);
/** Refresh the LanceDB index after the SQLite one (and load the similar-notes pairs it wrote). Never fatal: Ollama may be down, next run catches up. */
async function embedSoft(d: ReturnType<typeof openDb>, opts: { full?: boolean } = {}) {
  if (!cfg.embedding.enabled) return;
  try {
    const store = await VectorStore.open(cfg);
    const s = await embedNotes(cfg, store, makeEmbedder(cfg), { ...opts, log: (m) => warn(`embed: ${m}`) });
    if (s.embedded || s.removed) warn(`embed: +${s.embedded} -${s.removed} (${s.rows} chunks, ${s.tokenizer})`);
    loadSimilar(cfg, d);
  } catch (e) {
    warn(`embed: skipped (${(e as Error).message})`);
  }
}

switch (cmd) {
  case "types": {
    for (const t of reg.types.values()) console.log(`${t.type.padEnd(16)} ${t.folder.padEnd(28)} ${t.entity.padEnd(6)} status: ${t.statuses.join("|")}`);
    break;
  }
  case "new": {
    const { f, pos } = flags(argv);
    const [type, title] = pos;
    if (!type || !title) die('usage: kb new <type> "<title>" [--set k=v ...] [--force] [--folder 200_silver/207_work]');
    try {
      const p = createNote(cfg, reg, db(), { type, title, set: collectSets(argv), force: !!f.force, folder: f.folder as string | undefined });
      console.log(p);
    } catch (e) {
      if (e instanceof DuplicateError) die(`${e.message}\n  (use --force to create anyway, or update the existing note)`);
      throw e;
    }
    break;
  }
  case "set": {
    const { pos } = flags(argv);
    const [path] = pos;
    if (!path) die("usage: kb set <path> --set k=v [--set k=v]");
    const fm = patchFrontmatter(join(cfg.root, path), collectSets(argv), reg);
    const errs = reg.validate(fm);
    if (errs.length) die(`written, but frontmatter is now invalid:\n  ${errs.join("\n  ")}`);
    json(fm);
    break;
  }
  case "append": {
    const { f, pos } = flags(argv);
    const [path, ...rest] = pos;
    if (!path || !rest.length) die('usage: kb append <path> "<line>" [--section ログ]');
    appendToSection(join(cfg.root, path), String(f.section ?? "履歴"), rest.join(" "));
    console.log(path);
    break;
  }
  case "inbox": {
    for (const p of listInbox(cfg)) console.log(p);
    break;
  }
  case "ingest": {
    const { f, pos } = flags(argv);
    const targets = pos.length ? pos : f.all ? listInbox(cfg) : [];
    if (!targets.length) die("usage: kb ingest <path|url> [--kind web|note|mail|file|book] [--keep] | kb ingest --all");
    for (const t of targets) {
      const meta = /^https?:\/\//.test(t)
        ? await ingestUrl(cfg, t)
        : ingestFile(cfg, t, { kind: f.kind as BronzeKind | undefined, keep: !!f.keep });
      const dup = "duplicate" in meta && meta.duplicate;
      // already in Bronze: same content as an earlier capture, nothing new was stored (processed_to tells if it was handled)
      f.json ? json(meta) : console.log(`${meta.id}\t${meta.kind}\t${meta.title ?? meta.source}${dup ? `\talready in Bronze (processed: ${meta.processed_to.join(", ") || "no"})` : ""}`);
    }
    break;
  }
  case "source": {
    const { f, pos } = flags(argv);
    const [id] = pos;
    if (!id) die("usage: kb source <id> [--full] [--chars 1500]");
    const r = sourceExcerpt(cfg, id, { full: !!f.full, chars: f.chars ? Number(f.chars) : undefined });
    if (!r) { die(`no bronze item ${id}`); break; }
    if (f.json) json(r);
    else {
      console.log(`# ${r.meta.title ?? r.meta.source}\nid: ${r.meta.id}  kind: ${r.meta.kind}  captured: ${r.meta.captured_at}\nsource: ${r.meta.source}\nprocessed_to: ${r.meta.processed_to.join(", ") || "(none)"}\n---`);
      console.log(r.text + (r.truncated ? "\n…(truncated; --full for all)" : ""));
    }
    break;
  }
  case "processed": {
    const { f, pos } = flags(argv);
    const [id, ...paths] = pos;
    // --none: reviewed, nothing in it belongs in Silver (e.g. a feed with no relevant items)
    if (!id || (!paths.length && !f.none)) die("usage: kb processed <bronze-id> <silver-path>... | kb processed <bronze-id> --none");
    markProcessed(cfg, id, paths.length ? paths : ["-"]);
    console.log("ok");
    break;
  }
  case "query":
  case "q": {
    const { f, pos } = flags(argv);
    const { filters } = parseFilters(pos);
    const res = runQuery(db(), {
      filters, text: f.text as string | undefined, includeArchive: !!f["include-archive"],
      limit: f.limit ? Number(f.limit) : undefined, orderBy: f.order as string | undefined,
    });
    logAccess(cfg, { op: "query", filters, text: f.text, hits: res.length });
    if (f.json) json(res.map(({ fm, ...r }) => ({ ...r, ...pickFields(fm, f.fields as string | undefined) })));
    else for (const r of res) console.log(`${r.type.padEnd(16)} ${r.status.padEnd(9)} ${r.path}\n  ${r.title}${r.summary ? " — " + r.summary : ""}`);
    break;
  }
  case "index": {
    const d = openDb(cfg);
    const r = indexNotes(cfg, d, { full: argv.includes("--full") });
    await embedSoft(d, { full: argv.includes("--full") });
    json(r);
    break;
  }
  case "build": {
    const d = db();
    const files = buildGold(cfg, d);
    indexNotes(cfg, d);
    await embedSoft(d);
    console.log(files.join("\n"));
    break;
  }
  case "search":
  case "s": {
    const { f, pos } = flags(argv);
    const { filters, rest } = parseFilters(pos);
    const query = rest.join(" ");
    if (!query && !filters.length) die('usage: kb search "<query>" [type=book ...] [--mode hybrid|vector|keyword] [--limit 10] [--include-archive] [--spoilers] [--json]');
    const mode = (f.mode as SearchMode | undefined) ?? "hybrid";
    if (!["hybrid", "vector", "keyword"].includes(mode)) die(`--mode must be hybrid|vector|keyword`);
    const d = db();
    const res = await search(cfg, d, query, {
      mode, filters, includeArchive: !!f["include-archive"], limit: f.limit ? Number(f.limit) : undefined, spoilers: !!f.spoilers,
    }, { embedder: makeEmbedder(cfg) });
    logAccess(cfg, { op: "search", mode: res.mode, filters, text: query, hits: res.hits.length, degraded: res.degraded });
    if (f.json) { json(res); break; }
    if (res.degraded) warn(`search: ${res.mode} (degraded: ${res.degraded})`);
    for (const h of res.hits) {
      // ● high / ○ low confidence (see docs/search.md); vector matches also show their cosine distance
      console.log(`${h.confidence === "high" ? "●" : "○"} ${h.score.toFixed(4)}  ${h.type.padEnd(12)} ${h.path}${h.archived ? "  [archive]" : ""}\n  ${h.title}${h.summary ? " — " + h.summary : ""}`);
      for (const m of h.matches) console.log(`    [${m.via.join("+")}${m.vectorDistance != null ? ` d=${m.vectorDistance.toFixed(2)}` : ""}]${m.heading ? ` ${m.heading}:` : ""} ${m.snippet}`);
    }
    if (!res.hits.length) console.log("(no hits)");
    break;
  }
  case "embed": {
    const { f } = flags(argv);
    if (f.setup) {
      const st = await setupLindera(cfg, cfg.embedding.tokenizer, (m) => console.log(m));
      if (!st.ok) die(st.reason ?? "lindera setup failed");
      const emb = makeEmbedder(cfg);
      const ping = await emb.ping();
      if (!ping.ok) {
        console.log(`ollama: ${ping.reason}`);
        if (Bun.which("ollama")) {
          console.log(`pulling ${cfg.embedding.model} …`);
          const p = Bun.spawn(["ollama", "pull", cfg.embedding.model], { stdout: "inherit", stderr: "inherit" });
          if ((await p.exited) !== 0) die("ollama pull failed");
        }
      }
    }
    if (f.check || f.setup) {
      const emb = makeEmbedder(cfg);
      const ping = await emb.ping();
      const tok = resolveTokenizer(cfg);
      const lin = linderaStatus(cfg);
      const meta = readVectorMeta(cfg);
      json({
        enabled: cfg.embedding.enabled, host: cfg.embedding.host, model: cfg.embedding.model, ollama: ping.ok ? "ok" : ping.reason,
        tokenizer: tok.tokenizer, tokenizerFallback: tok.fallback ?? null, lindera: lin, lanceDir: cfg.lanceDir, index: meta,
      });
      if (!ping.ok || tok.fallback) process.exit(1);
      break;
    }
    if (!cfg.embedding.enabled) die("embedding disabled (KB_EMBED=off or [embedding] enabled=false)");
    const store = await VectorStore.open(cfg);
    const d = openDb(cfg);
    indexNotes(cfg, d);
    const s = await embedNotes(cfg, store, makeEmbedder(cfg), { full: !!f.full, log: (m) => warn(`embed: ${m}`) });
    loadSimilar(cfg, d);
    json(s);
    break;
  }
  case "archive": {
    const { f, pos } = flags(argv);
    // --status is required: an archived note says why it ended; --superseded-by names where it continues (merged / replaced)
    const status = f.status;
    if (!pos[0] || typeof status !== "string" || !status) { die("usage: kb archive <path> --status <done|cancelled|merged|closed|…> [--superseded-by <silver-path>]"); break; }
    json(archiveNote(cfg, pos[0], { status, supersededBy: f["superseded-by"] as string | undefined, reg }));
    break;
  }
  case "validate": {
    const quiet = argv.includes("--quiet");
    const issues = validateAll(cfg, reg);
    const errors = issues.filter((i) => i.level === "error");
    if (!quiet) for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(5)} ${i.path}: ${i.msg}`);
    if (!quiet) console.log(`${errors.length} error(s), ${issues.length - errors.length} warning(s)`);
    process.exit(errors.length ? 1 : 0);
  }
  case "lint": {
    const { bronze, ...lists } = lint(cfg, db());
    if (argv.includes("--json")) json({ bronze, ...lists });
    else {
      for (const [k, v] of Object.entries(lists)) if (v.length) console.log(`## ${k}\n` + v.map((x: string) => `- ${x}`).join("\n"));
      // kind × processing state; mail per Gmail category under its kind row
      if (bronze.length) console.log("## bronze (silver / - / unprocessed)\n" + bronze.map((b) =>
        `- ${b.category ? `  ${b.kind}/${b.category}` : b.kind}: ${b.total} = ${b.silver} / ${b.none} / ${b.unprocessed}`).join("\n"));
    }
    break;
  }
  case "backup": {
    const { f } = flags(argv);
    const r = await backupBronze(cfg, { dest: f.dest as string | undefined, dryRun: !!f["dry-run"] });
    console.log(r.output);
    console.log(`-> ${r.dest}${f["dry-run"] ? " (dry run)" : ""}`);
    break;
  }
  case "prune": {
    const { f } = flags(argv);
    const years = f["older-than"] ? parseFloat(String(f["older-than"])) : 3;
    const r = pruneBronze(cfg, { olderThanYears: years, kind: f.type as string | undefined, dryRun: !!f["dry-run"] });
    console.log(r.join("\n") || "(nothing to prune)");
    break;
  }
  case "portfolio": {
    const { f, pos } = flags(argv);
    const [sub, src] = pos;
    if (sub !== "import" || !src) die('usage: kb portfolio import <csv|bronze-id> [--account 楽天証券]');
    const r = importPortfolio(cfg, reg, db(), { src: src!, account: String(f.account ?? "楽天証券") });
    console.log(`${r.created ? "created" : "updated"} ${r.path} (as of ${r.asOf}, ${r.positions} positions${r.bronzeId ? `, from ${r.bronzeId}` : ""})`);
    break;
  }
  case "book": {
    const { f, pos } = flags(argv);
    const [sub, id] = pos;
    if (sub !== "import" || !id) die("usage: kb book import <bronze-id> [--status want|read]   (a 楽天Kobo library export CSV)");
    const r = importKoboLibrary(cfg, reg, db(), id!, { status: f.status ? String(f.status) : undefined });
    for (const c of r.created) console.log(`created ${c.path}`);
    console.log(`${r.created.length} created, ${r.skipped.length} already in 204_books (from ${r.bronzeId})`);
    break;
  }
  case "mail": {
    const { f, pos } = flags(argv);
    const [sub, ...ids] = pos;
    const all = !!(f.all || f["all-unprocessed"]);
    if (sub !== "import" || (!ids.length && !all)) die("usage: kb mail import <bronze-id>... | --all [--dry-run] [--json]   (Gmail items: routine notices → processed -, the rest → ledger candidates matched against the ledger)");
    const r = importMail(cfg, db(), { ids, all, dryRun: !!f["dry-run"] });
    f.json ? json(r) : console.log(formatMailImport(r, { dryRun: !!f["dry-run"] }));
    break;
  }
  case "articles": {
    // curate: RSS feed entries → `curate` skill (JSON in, JSON out) → 900_system/articles/<date>.json. The agent's output
    // goes to stderr so stdout stays the result (--json for the worker).
    const { f, pos } = flags(argv);
    const sub = pos[0];
    if (sub === "curate") {
      const script = join(cfg.root, LAYOUT.system, "scripts", "run-agent.sh");
      const run = async (inPath: string, outPath: string) => {
        const proc = Bun.spawn(["bash", script, "curate", inPath, outPath], { cwd: cfg.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, KB_ROOT: cfg.root } });
        const pump = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s) process.stderr.write(chunk); };
        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        if ((await proc.exited) !== 0) throw new Error("curate: the agent exited with an error");
      };
      const r = await curateArticles(cfg, { date: typeof f.date === "string" ? f.date : undefined, db: db(), dry: !!f.dry, run });
      if (r.input) { json(r.input); break; }
      for (const w of r.warnings) warn(`warn: ${w}`);
      const picks = r.day ? r.day.items.filter((i) => i.picked) : [];
      const summary = { skipped: !!r.skipped, date: r.day?.date ?? null, path: r.path ?? null, candidates: r.candidates, picked: picks.length, top: picks.slice(0, 3).map((i) => i.title), warnings: r.warnings };
      if (f.json) json(summary);
      else if (r.skipped) console.log("articles: nothing new in the feeds");
      else console.log(`${r.path}\t${picks.length} picks / ${r.candidates} candidates`);
      break;
    }
    if (sub === "history") { json(buildHistory(listArticleDays(cfg))); break; }
    if (sub === "stats") { for (const d of listArticleDays(cfg, { limit: 14 })) { const s = articleStats(d); console.log(`${d.date}\tpicked ${s.picked}/${s.candidates}\topened ${s.opened}\tsaved ${s.saved}\tdismissed ${s.dismissed}`); } break; }
    die("usage: kb articles curate [--date YYYY-MM-DD] [--dry] [--json] | kb articles history | kb articles stats");
  }
  case "root": {
    console.log(cfg.root);
    break;
  }
  case "health": {
    const { pos } = flags(argv);
    const [sub, id] = pos;
    if (sub !== "import" || !id) die("usage: kb health import <bronze-id>   (a collect-health-*.json feed)");
    const r = importHealth(cfg, reg, db(), id!);
    for (const m of r.months) console.log(`${m.created ? "created" : "updated"} ${m.path} (${m.days} days)`);
    if (!r.months.length) console.log(`no days in ${r.bronzeId}; marked processed`);
    break;
  }
  case "calendar": {
    const { pos } = flags(argv);
    const [sub, id] = pos;
    if (sub !== "import" || !id) die("usage: kb calendar import <bronze-id>   (a collect-calendar feed; replays every calendar feed in Bronze)");
    const r = importCalendar(cfg, reg, db(), id!);
    for (const m of r.months) console.log(`${m.created ? "created" : "updated"} ${m.path} (実績 ${m.done} / 予定 ${m.planned})`);
    break;
  }
  case "location": {
    const { f, pos } = flags(argv);
    const [sub, id] = pos;
    if (sub !== "import" || !id) die("usage: kb location import <bronze-id> [--max-lookups 300] [--all]   (a Google Maps Timeline export)");
    const r = await importLocation(cfg, reg, db(), id!, { maxLookups: f["max-lookups"] ? Number(f["max-lookups"]) : undefined, all: !!f.all });
    if (r.ttlWarning) console.log(`warning: ${r.ttlWarning}`);
    for (const m of r.months) console.log(`${m.created ? "created" : "updated"} ${m.path} (${m.visits} visits${m.unresolved ? `, ${m.unresolved} 未取得` : ""})`);
    if (r.skippedMonths.length) console.log(`skipped ${r.skippedMonths.length} month(s) already recorded (--all to rebuild): ${r.skippedMonths[0]}..${r.skippedMonths.at(-1)}`);
    console.log(`places: ${r.cached} cached, ${r.fetched} fetched${r.deferred ? `, ${r.deferred} deferred (rerun: kb location import ${r.bronzeId})` : ""}`);
    if (r.notable.length) {
      console.log("notable visits:");
      for (const { visit: v, place: p } of r.notable) console.log(`  ${new Date(v.start).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })} ${p!.name} (${p!.primaryType})`);
    }
    break;
  }
  case "collect": {
    // Scheduled runs use `bun run collect` (apps/collector, loads its .env). Here: sources that need no secrets,
    // e.g. `kb collect linkedin` from the ingest skill when an export ZIP is waiting in the inbox.
    const { f, pos } = flags(argv);
    const reports = await runCollectors(cfg, process.env, { only: pos.length ? pos : undefined, dryRun: !!f["dry-run"] });
    for (const r of reports) console.log(`${r.id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.written.length ? ` → ${r.written.join(", ")}` : ""}`);
    if (reports.some((r) => r.status === "failed")) process.exitCode = 1;
    break;
  }
  default:
    console.log(`kb — personal knowledge base CLI (KB_ROOT=${cfg.root})

  types                              list note types, folders, statuses
  new <type> "<title>" [--set k=v]   create a Silver note from its template (duplicate-checked)
  set <path> --set k=v               patch frontmatter (updated= today)
  append <path> "<line>" [--section] append a dated bullet to a section
  inbox                              list 000_inbox
  ingest <path|url> [--kind] [--keep] | --all   move into Bronze, print id
  source <id> [--full]               Bronze meta + excerpt (logged)
  processed <id> <silver-path>... | <id> --none   record which Silver notes came from a Bronze item (--none: nothing to reflect; rss feeds get the 900_system/articles day file from \`kb articles curate\`)
  articles curate [--date d] [--dry] [--json]   RSS feed entries → \`curate\` skill (JSON only) → 900_system/articles/<date>.json (+ Bronze processed); --dry prints the agent's input
  articles history | articles stats  what happened to earlier picks (the agent's feedback) | per-day counts
  health import <bronze-id>          rebuild the monthly health_log notes from a collect-health feed
  calendar import <bronze-id>        monthly calendar_log notes (212_calendar) from the collect-calendar feeds
  location import <bronze-id> [--max-lookups 300] [--all]   Google Maps Timeline export → monthly location_log (Places API, 70-day cache)
  collect [source...] [--dry-run]    run collectors into 000_inbox (secrets: use \`bun run collect\` with apps/collector/.env)
  portfolio import <csv|bronze-id> [--account 楽天証券]   update the portfolio note from a 楽天証券 asset CSV (CP932 ok)
  book import <bronze-id> [--status want|read]   book notes (imported: true, purchased_at) from a 楽天Kobo library export CSV; existing titles are skipped
  mail import <bronze-id>... | --all [--dry-run] [--json]   Gmail items: routine notices (900_system/mail-rules.json) → processed -; money mails → ledger candidates (amount / date / merchant) matched against the ledger
  query [type=book rating>=4] [--text "..."] [--include-archive] [--json] [--limit n] [--order -updated]
  search "<query>" [type=book ...] [--mode hybrid|vector|keyword] [--limit 10] [--include-archive] [--spoilers] [--json]
                                     semantic + keyword search (LanceDB; Ollama for vectors). ● high / ○ low confidence
  embed [--full] | embed --check | embed --setup   (re)embed Silver into LanceDB | status | install Lindera dict + pull model
  index [--full] | build             refresh SQLite + LanceDB index | regenerate 300_gold
  archive <path> --status <s> [--superseded-by <silver-path>]   move to _archive/ with its final status (and successor); rewrite links and Bronze processed_to
  validate [--quiet] | lint [--json]
  backup [--dest d] [--dry-run] | prune [--older-than 3] [--type web] [--dry-run]`);
}

function pickFields(fm: Record<string, unknown>, fields?: string) {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const k of fields.split(",")) out[k] = fm[k];
  return out;
}
