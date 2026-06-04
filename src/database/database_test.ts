import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "./database.js";

describe("Database", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "elf-db-"));
    db = new Database(dir);
    await db.start();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets and gets a value", async () => {
    await db.setValue("customers/123/name", "Ada");
    assert.deepEqual(await db.getValue("customers/123/name"), {
      ok: true,
      value: "Ada",
    });
  });

  it("returns an error Result for a missing key", async () => {
    const res = await db.getValue("nope");
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /no value/);
  });

  it("overwrites on set (upsert)", async () => {
    await db.setValue("k", "first");
    await db.setValue("k", "second");
    assert.deepEqual(await db.getValue("k"), { ok: true, value: "second" });
  });

  it("deletes a value, idempotently", async () => {
    await db.setValue("k", "v");
    await db.deleteValue("k");
    assert.equal((await db.getValue("k")).ok, false);
    // deleting a missing key is a no-op
    await db.deleteValue("k");
  });

  it("lists keys by prefix", async () => {
    await db.setValue("customers/1", "a");
    await db.setValue("customers/2", "b");
    await db.setValue("orders/9", "c");

    const customers = await db.listKeysWithPrefix("customers/");
    assert.equal(customers.ok, true);
    assert.deepEqual(customers.ok ? customers.value.sort() : null, [
      "customers/1",
      "customers/2",
    ]);
  });

  it("an empty prefix lists every key", async () => {
    await db.setValue("a", "1");
    await db.setValue("b/c", "2");
    const all = await db.listKeysWithPrefix("");
    assert.deepEqual(all.ok ? all.value.sort() : null, ["a", "b/c"]);
  });

  it("round-trips keys with separators, dots, and unicode", async () => {
    const keys = ["a/b/c", "..", ".", "a.b.c", "weird key!", "naïve/café"];
    for (const k of keys) await db.setValue(k, `val:${k}`);
    for (const k of keys) {
      assert.deepEqual(await db.getValue(k), { ok: true, value: `val:${k}` });
    }
    const listed = await db.listKeysWithPrefix("");
    assert.deepEqual(listed.ok ? listed.value.sort() : null, [...keys].sort());
  });

  it("does not let a dotted key escape the data dir", async () => {
    // The key ".." must address an entry, not the parent directory.
    await db.setValue("..", "contained");
    assert.deepEqual(await db.getValue(".."), { ok: true, value: "contained" });
    const top = await readdir(dir);
    assert.deepEqual(top, ["database"]); // nothing written outside database/
  });

  it("rejects an empty key on write", async () => {
    await assert.rejects(() => db.setValue("", "x"));
  });

  it("leaves no temp files behind after a write", async () => {
    await db.setValue("k", "v");
    const files = await readdir(path.join(dir, "database"));
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
  });
});

describe("Database persistence", () => {
  it("reads back values written by a prior instance (disk is source of truth)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-db-persist-"));
    try {
      const first = new Database(dir);
      await first.start();
      await first.setValue("config/region", "us-east");

      const second = new Database(dir);
      await second.start();
      assert.deepEqual(await second.getValue("config/region"), {
        ok: true,
        value: "us-east",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
