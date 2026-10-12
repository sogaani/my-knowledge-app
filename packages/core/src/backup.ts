import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "./config";
import { bronzeDir, walkBronze } from "./bronze";

/** Append-only rsync of Bronze to dest. Never deletes on the destination. */
export async function backupBronze(cfg: KbConfig, opts: { dest?: string; dryRun?: boolean }): Promise<{ dest: string; output: string }> {
  const dest = opts.dest ?? cfg.local.backup?.dest;
  if (!dest) throw new Error("no backup destination: pass --dest or set [backup] dest in 900_system/config.local.toml");
  mkdirSync(dest, { recursive: true });
  const args = ["rsync", "-a", "--ignore-existing", "--itemize-changes", "--human-readable", "--stats"];
  if (opts.dryRun) args.push("--dry-run");
  args.push(cfg.bronze.replace(/\/?$/, "/"), dest.replace(/\/?$/, "/"));
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`rsync failed (${code}): ${err}`);
  mkdirSync(cfg.logs, { recursive: true });
  appendFileSync(join(cfg.logs, "backup.log"), `[${new Date().toISOString()}] ${opts.dryRun ? "DRY " : ""}-> ${dest}\n${out}\n`);
  return { dest, output: out };
}

/** Remove raw files (not meta.json) of old, already-processed Bronze items of a kind. */
export function pruneBronze(cfg: KbConfig, opts: { olderThanYears: number; kind?: string; dryRun?: boolean }): string[] {
  const cutoff = Date.now() - opts.olderThanYears * 365 * 86400000;
  const pruned: string[] = [];
  for (const m of walkBronze(cfg)) {
    if (opts.kind && m.kind !== opts.kind) continue;
    if (m.processed_to.length === 0) continue;
    if (new Date(m.captured_at).getTime() > cutoff) continue;
    const dir = bronzeDir(cfg, m.id);
    for (const f of readdirSync(dir)) {
      if (f === "meta.json") continue;
      pruned.push(`${m.id}/${f}`);
      if (!opts.dryRun) rmSync(join(dir, f), { recursive: true, force: true });
    }
  }
  return pruned;
}
