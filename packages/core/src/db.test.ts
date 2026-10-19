import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { INDEX_VERSION, indexIsEmpty, indexNotes, openDb } from "./db";

describe("indexNotes({ paths })", () => {
  test("re-reads only the given files / folders and drops deleted notes under them", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-index-"));
    const w = (rel: string, title: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), `---\ntype: book\ntitle: ${title}\n---\nbody\n`);
    };
    w("200_silver/304_books/a.md", "A");
    w("200_silver/304_books/b.md", "B");
    w("200_silver/303_projects/p/README.md", "P");
    const cfg = loadConfig(root);
    const db = openDb(cfg);
    indexNotes(cfg, db);
    const titles = () => (db.query("SELECT title FROM notes ORDER BY title").all() as { title: string }[]).map((r) => r.title);
    expect(titles()).toEqual(["A", "B", "P"]);

    // b changes on disk but only a is named: b stays stale
    w("200_silver/304_books/a.md", "A2");
    w("200_silver/304_books/b.md", "B2");
    expect(indexNotes(cfg, db, { paths: ["200_silver/304_books/a.md"] })).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(titles()).toEqual(["A2", "B", "P"]);

    // an attachment of a folder entity re-reads its README; a deleted file is removed; outside paths are ignored
    w("200_silver/303_projects/p/README.md", "P2");
    rmSync(join(root, "200_silver/304_books/a.md"));
    const r = indexNotes(cfg, db, { paths: ["200_silver/303_projects/p/log.md", "200_silver/304_books/a.md", "000_inbox/x.md"] });
    expect(r).toEqual({ added: 0, updated: 1, removed: 1 });
    expect(titles()).toEqual(["B", "P2"]);

    // a folder path walks everything below it, including a deleted entity folder
    rmSync(join(root, "200_silver/303_projects/p"), { recursive: true });
    w("200_silver/304_books/c.md", "C");
    expect(indexNotes(cfg, db, { paths: ["200_silver/303_projects", "200_silver/304_books/"] })).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(titles()).toEqual(["B2", "C"]);
  });
});

describe("openDb / INDEX_VERSION", () => {
  test("keeps rows across reopen, drops them when the stored version differs, and a plain reindex refills by mtime", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-index-"));
    mkdirSync(join(root, "200_silver/304_books"), { recursive: true });
    writeFileSync(join(root, "200_silver/304_books/a.md"), "---\ntype: book\ntitle: A\n---\nbody\n");
    const cfg = loadConfig(root);
    const count = (db: ReturnType<typeof openDb>) => (db.query("SELECT count(*) n FROM notes").get() as { n: number }).n;

    let db = openDb(cfg);
    expect(indexIsEmpty(db)).toBe(true);
    expect(indexNotes(cfg, db)).toEqual({ added: 1, updated: 0, removed: 0 });
    db.close();

    // same version: the file is reused and an unchanged note is not re-read
    db = openDb(cfg);
    expect(indexIsEmpty(db)).toBe(false);
    expect(count(db)).toBe(1);
    expect(indexNotes(cfg, db)).toEqual({ added: 0, updated: 0, removed: 0 });
    db.run("UPDATE meta SET v='0' WHERE k='index_version'");
    db.close();

    // stale version: everything is dropped and the next incremental index is effectively full
    db = openDb(cfg);
    expect(indexIsEmpty(db)).toBe(true);
    expect((db.query("SELECT v FROM meta WHERE k='index_version'").get() as { v: string }).v).toBe(String(INDEX_VERSION));
    expect(indexNotes(cfg, db)).toEqual({ added: 1, updated: 0, removed: 0 });
    db.close();
  });
});
