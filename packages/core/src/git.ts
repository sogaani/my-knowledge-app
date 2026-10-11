/** Thin git helpers used by the API pod and the worker. All run in `cwd`. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  return out.trim();
}

/** HEAD sha, or "" for a repo with no commits yet. */
export const gitHead = (cwd: string) => git(cwd, "rev-parse", "HEAD").catch(() => "");

export async function gitPull(cwd: string): Promise<{ before: string; after: string }> {
  const before = await gitHead(cwd);
  if (!(await hasUpstream(cwd))) return { before, after: before }; // local-only checkout (dev)
  await git(cwd, "pull", "--ff-only", "--quiet");
  return { before, after: await gitHead(cwd) };
}

/** True when the current branch tracks a remote branch. */
export const hasUpstream = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "@{u}").then(() => true, () => false);

/** Stage paths, commit, and push (when an upstream exists) with a rebase-retry. Returns the new HEAD, or null if nothing to commit. */
export async function gitCommitPush(cwd: string, paths: string[], message: string, opts: { author?: string; retries?: number } = {}): Promise<string | null> {
  await git(cwd, "add", "-A", "--", ...paths);
  const status = await git(cwd, "status", "--porcelain", "--", ...paths);
  if (!status) return null;
  const authorArgs = opts.author ? ["--author", opts.author] : [];
  await git(cwd, "commit", "--quiet", "-m", message, ...authorArgs);
  if (!(await hasUpstream(cwd))) return gitHead(cwd);
  for (let i = 0; i <= (opts.retries ?? 3); i++) {
    try {
      await git(cwd, "push", "--quiet");
      return await gitHead(cwd);
    } catch (e) {
      if (i === (opts.retries ?? 3)) throw e;
      await git(cwd, "pull", "--rebase", "--quiet");
    }
  }
  return null;
}
