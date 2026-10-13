/** Thin git helpers used by the API pod and the worker. All run in `cwd`. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  return out;
}

/** HEAD sha, or "" for a repo with no commits yet. */
export const gitHead = (cwd: string) => git(cwd, "rev-parse", "HEAD").catch(() => "");

export async function gitPull(cwd: string, opts: { rebase?: boolean } = {}): Promise<{ before: string; after: string }> {
  const before = await gitHead(cwd);
  if (!(await hasUpstream(cwd))) return { before, after: before }; // local-only checkout (dev)
  if (opts.rebase) await pullRebase(cwd);
  else await git(cwd, "pull", "--ff-only", "--quiet");
  return { before, after: await gitHead(cwd) };
}

/** True when the current branch tracks a remote branch. */
export const hasUpstream = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "@{u}").then(() => true, () => false);

/**
 * `git pull --rebase`; on a conflict the rebase is aborted so the checkout is not left mid-rebase.
 * --autostash: the API may have a just-written file that its commit has not picked up yet.
 */
async function pullRebase(cwd: string) {
  try {
    await git(cwd, "pull", "--rebase", "--autostash", "--quiet");
  } catch (e) {
    await git(cwd, "rebase", "--abort").catch(() => {});
    throw e;
  }
}

/** Files changed between two commits (repo-relative). */
export async function gitChangedFiles(cwd: string, from: string, to: string): Promise<string[]> {
  if (!from || !to || from === to) return [];
  return (await git(cwd, "diff", "--name-only", "--no-renames", from, to)).split("\n").filter(Boolean);
}

/** `git status --porcelain` of the given paths: two-letter status + repo-relative path (untracked = `??`). */
export async function gitStatusPaths(cwd: string, paths: string[]): Promise<{ status: string; path: string }[]> {
  // raw: a modified-in-worktree entry starts with a space (" M"), which git()'s trim would eat
  const out = await gitRaw(cwd, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths]);
  return out.split("\0").filter((e) => e.length > 3).map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }));
}

/** Local commits not on the upstream yet (0 without an upstream). */
export const gitUnpushed = (cwd: string) => git(cwd, "rev-list", "--count", "@{u}..HEAD").then(Number, () => 0);

/** Stage paths and commit locally. Returns the new HEAD, or null if nothing to commit. */
export async function gitCommit(cwd: string, paths: string[], message: string, opts: { author?: string } = {}): Promise<string | null> {
  await git(cwd, "add", "-A", "--", ...paths);
  const status = await git(cwd, "status", "--porcelain", "--", ...paths);
  if (!status) return null;
  const authorArgs = opts.author ? ["--author", opts.author] : [];
  await git(cwd, "commit", "--quiet", "-m", message, ...authorArgs);
  return gitHead(cwd);
}

/** Push (when an upstream exists) with a rebase-retry. Returns HEAD after the push. */
export async function gitPush(cwd: string, opts: { retries?: number } = {}): Promise<string> {
  if (!(await hasUpstream(cwd))) return gitHead(cwd);
  for (let i = 0; ; i++) {
    try {
      await git(cwd, "push", "--quiet");
      return await gitHead(cwd);
    } catch (e) {
      if (i >= (opts.retries ?? 3)) throw e;
      await pullRebase(cwd);
    }
  }
}

/** Stage paths, commit, and push (when an upstream exists) with a rebase-retry. Returns the new HEAD, or null if nothing to commit. */
export async function gitCommitPush(cwd: string, paths: string[], message: string, opts: { author?: string; retries?: number } = {}): Promise<string | null> {
  if (!(await gitCommit(cwd, paths, message, opts))) return null;
  return gitPush(cwd, opts);
}
