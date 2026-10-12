import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitChangedFiles, gitCommit, gitHead, gitPull, gitPush, gitUnpushed } from "./git";

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
