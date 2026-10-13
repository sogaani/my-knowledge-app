import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitChangedFiles, gitCommit, gitHead, gitPull, gitPush, gitStatusPaths, gitUnpushed } from "./git";

async function clone(remote: string, name: string) {
  const dir = join(remote, "..", name);
  await git(join(remote, ".."), "clone", "--quiet", remote, dir);
  await git(dir, "config", "user.email", "t@local");
  await git(dir, "config", "user.name", "t");
  return dir;
}

describe("gitCommit / gitPush", () => {
  test("commit stays local until pushed; push rebases onto a moved remote", async () => {
    const base = mkdtempSync(join(tmpdir(), "kb-git-"));
    const remote = join(base, "remote.git");
    await git(base, "init", "--quiet", "--bare", "-b", "main", remote);
    const a = await clone(remote, "a");
    writeFileSync(join(a, "x.md"), "x\n");
    await gitCommit(a, ["x.md"], "init");
    await git(a, "push", "--quiet", "-u", "origin", "main");
    const b = await clone(remote, "b");

    // nothing staged → null
    expect(await gitCommit(a, ["x.md"], "noop")).toBeNull();

    writeFileSync(join(a, "y.md"), "y\n");
    const sha = await gitCommit(a, ["y.md"], "add y");
    expect(sha).toBe(await gitHead(a));
    expect(await gitUnpushed(a)).toBe(1);

    // the remote moves meanwhile: push must rebase and still land both commits
    writeFileSync(join(b, "z.md"), "z\n");
    await gitCommit(b, ["z.md"], "add z");
    await gitPush(b);

    const before = await gitHead(a);
    const after = await gitPush(a);
    expect(after).not.toBe(before);
    expect(await gitUnpushed(a)).toBe(0);
    expect(await gitChangedFiles(a, before, after)).toEqual(["z.md"]);

    const pulled = await gitPull(b, { rebase: true });
    expect(await gitChangedFiles(b, pulled.before, pulled.after)).toEqual(["y.md"]);
  });
});

describe("gitStatusPaths", () => {
  test("untracked, modified (worktree) and non-ASCII names, limited to the given paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-git-status-"));
    await git(dir, "init", "--quiet", "-b", "main");
    await git(dir, "config", "user.email", "t@local");
    await git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, "200_silver"), { recursive: true });
    mkdirSync(join(dir, "300_gold"), { recursive: true });
    writeFileSync(join(dir, "200_silver", "既存.md"), "a\n");
    await gitCommit(dir, ["200_silver"], "init");
    writeFileSync(join(dir, "200_silver", "既存.md"), "b\n");
    writeFileSync(join(dir, "200_silver", "新規.md"), "n\n");
    writeFileSync(join(dir, "300_gold", "x.md"), "g\n");
    const r = await gitStatusPaths(dir, ["200_silver"]);
    expect(r.sort((x, y) => x.status.localeCompare(y.status))).toEqual([{ status: " M", path: "200_silver/既存.md" }, { status: "??", path: "200_silver/新規.md" }]);
  });
});
