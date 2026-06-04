import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NotesManager } from "./notes_manager.js";

describe("NotesManager", () => {
  let dir: string;
  let nm: NotesManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "elf-notes-"));
    nm = new NotesManager(dir);
    await nm.start();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets and gets a note", async () => {
    await nm.setNote("Purpose", "Serve the auth slice.");
    assert.equal(nm.getNote("Purpose"), "Serve the auth slice.");
    assert.equal(nm.getNote("missing"), undefined);
  });

  it("lists notes", async () => {
    await nm.setNote("Purpose", "p");
    await nm.setNote("Tasks", "t");
    assert.deepEqual(nm.listNotes().sort(), ["Purpose", "Tasks"]);
  });

  it("overwrites on set (upsert, no duplicate error)", async () => {
    await nm.setNote("Memory", "first");
    await nm.setNote("Memory", "second");
    assert.equal(nm.getNote("Memory"), "second");
    assert.deepEqual(nm.listNotes(), ["Memory"]);
  });

  it("deletes a note", async () => {
    await nm.setNote("Tasks", "do the thing");
    await nm.deleteNote("Tasks");
    assert.equal(nm.getNote("Tasks"), undefined);
    assert.deepEqual(nm.listNotes(), []);
    // deleting a missing note is a no-op
    await nm.deleteNote("Tasks");
  });

  it("rejects invalid names", async () => {
    await assert.rejects(() => nm.setNote("../evil", "x"));
    await assert.rejects(() => nm.setNote("has/slash", "x"));
  });
});

describe("NotesManager persistence", () => {
  it("restores notes across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-notes-persist-"));
    try {
      const first = new NotesManager(dir);
      await first.start();
      await first.setNote("Purpose", "Build the API.");
      await first.setNote("Memory", "Learned X about Y.");

      const second = new NotesManager(dir);
      await second.start();
      assert.deepEqual(second.listNotes().sort(), ["Memory", "Purpose"]);
      assert.equal(second.getNote("Purpose"), "Build the API.");
      assert.equal(second.getNote("Memory"), "Learned X about Y.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a deleted note on restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-notes-persist-"));
    try {
      const first = new NotesManager(dir);
      await first.start();
      await first.setNote("Tasks", "transient");
      await first.deleteNote("Tasks");

      const second = new NotesManager(dir);
      await second.start();
      assert.deepEqual(second.listNotes(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
