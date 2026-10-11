#!/usr/bin/env bun
import { join } from "node:path";
import {
  loadConfig, openDb, indexNotes, SchemaRegistry, createNote, DuplicateError, patchFrontmatter, appendToSection,
  ingestFile, ingestUrl, sourceExcerpt, markProcessed, listInbox, parseFilters, runQuery, buildGold,
  validateAll, archiveNote, lint, backupBronze, pruneBronze, logAccess, importPortfolio, type BronzeKind,
  search, VectorStore, embedNotes, makeEmbedder, setupLindera, linderaStatus, resolveTokenizer, readVectorMeta, type SearchMode,
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
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--") && ["set", "dest", "kind", "text", "status", "older-than", "type", "limit", "order", "chars", "title", "folder", "section", "fields", "mode", "account"].includes(k)) f[k] = args[++i];
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
/** Refresh the LanceDB index after the SQLite one. Never fatal: Ollama may be down, next run catches up. */
async function embedSoft(opts: { full?: boolean } = {}) {
  if (!cfg.embedding.enabled) return;
  try {
    const store = await VectorStore.open(cfg);
    const s = await embedNotes(cfg, store, makeEmbedder(cfg), { ...opts, log: (m) => warn(`embed: ${m}`) });
    if (s.embedded || s.removed) warn(`embed: +${s.embedded} -${s.removed} (${s.rows} chunks, ${s.tokenizer})`);
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
    if (!type || !title) die('usage: kb new <type> "<title>" [--set k=v ...] [--force] [--folder 20_silver/27_work]');
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
      f.json ? json(meta) : console.log(`${meta.id}\t${meta.kind}\t${meta.title ?? meta.source}`);
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
    const { pos } = flags(argv);
    const [id, ...paths] = pos;
    if (!id || !paths.length) die("usage: kb processed <bronze-id> <silver-path>...");
    markProcessed(cfg, id, paths);
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
    await embedSoft({ full: argv.includes("--full") });
    json(r);
    break;
  }
  case "build": {
    const d = db();
    const files = buildGold(cfg, d);
    indexNotes(cfg, d);
    await embedSoft();
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
      console.log(`${h.score.toFixed(4)}  ${h.type.padEnd(12)} ${h.path}${h.archived ? "  [archive]" : ""}\n  ${h.title}${h.summary ? " — " + h.summary : ""}`);
      for (const m of h.matches) console.log(`    [${m.via.join("+")}]${m.heading ? ` ${m.heading}:` : ""} ${m.snippet}`);
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
    json(s);
    break;
  }
  case "archive": {
    const { f, pos } = flags(argv);
    if (!pos[0]) die("usage: kb archive <path> [--status done]");
    json(archiveNote(cfg, pos[0], { status: f.status as string | undefined }));
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
    const r = lint(cfg, db());
    if (argv.includes("--json")) json(r);
    else for (const [k, v] of Object.entries(r)) if (v.length) console.log(`## ${k}\n` + v.map((x: string) => `- ${x}`).join("\n"));
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
  case "root": {
    console.log(cfg.root);
    break;
  }
  default:
    console.log(`kb — personal knowledge base CLI (KB_ROOT=${cfg.root})

  types                              list note types, folders, statuses
  new <type> "<title>" [--set k=v]   create a Silver note from its template (duplicate-checked)
  set <path> --set k=v               patch frontmatter (updated= today)
  append <path> "<line>" [--section] append a dated bullet to a section
  inbox                              list 00_inbox
  ingest <path|url> [--kind] [--keep] | --all   move into Bronze, print id
  source <id> [--full]               Bronze meta + excerpt (logged)
  processed <id> <silver-path>...    record which Silver notes came from a Bronze item
  portfolio import <csv|bronze-id> [--account 楽天証券]   update the portfolio note from a 楽天証券 asset CSV (CP932 ok)
  query [type=book rating>=4] [--text "..."] [--include-archive] [--json] [--limit n] [--order -updated]
  search "<query>" [type=book ...] [--mode hybrid|vector|keyword] [--limit 10] [--include-archive] [--spoilers] [--json]
                                     semantic + keyword search (LanceDB; Ollama for vectors)
  embed [--full] | embed --check | embed --setup   (re)embed Silver into LanceDB | status | install Lindera dict + pull model
  index [--full] | build             refresh SQLite + LanceDB index | regenerate 30_gold
  archive <path> [--status done]     move to _archive/ and rewrite links
  validate [--quiet] | lint [--json]
  backup [--dest d] [--dry-run] | prune [--older-than 3] [--type web] [--dry-run]`);
}

function pickFields(fm: Record<string, unknown>, fields?: string) {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const k of fields.split(",")) out[k] = fm[k];
  return out;
}
