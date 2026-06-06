import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FunctionManager } from "./function_manager.js";
import type { JsonSchema } from "../utils/schema.js";

// input: { a, b }  ->  output: number
const TWO_NUMBERS: JsonSchema = {
  type: "object",
  properties: { a: { type: "number" }, b: { type: "number" } },
};
const NUMBER: JsonSchema = { type: "number" };

const ADD_CODE = `export async function handle(input) { return input.a + input.b; }`;

describe("FunctionManager", () => {
  let dir: string;
  let fm: FunctionManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "elf-fm-"));
    fm = new FunctionManager(dir, { execTimeoutMs: 2000 });
    await fm.start();
  });

  afterEach(async () => {
    await fm.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates and executes a function", async () => {
    await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    const res = await fm.executeFunc("add", JSON.stringify({ a: 2, b: 3 }));
    assert.deepEqual(res, { ok: true, value: "5" });
  });

  it("exposes the function via getFunc/listFuncs", async () => {
    await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    assert.deepEqual(fm.listFuncs(), ["add"]);
    assert.equal(fm.getFunc("add")?.code, ADD_CODE);
    assert.equal(fm.getFunc("missing"), undefined);
  });

  it("rejects duplicate and invalid names", async () => {
    await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    await assert.rejects(() => fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER));
    await assert.rejects(() => fm.createFunc("../evil", ADD_CODE, TWO_NUMBERS, NUMBER));
  });

  it("hot-reloads code via modifyFunc", async () => {
    await fm.createFunc("op", ADD_CODE, TWO_NUMBERS, NUMBER);
    await fm.modifyFunc("op", `export async function handle(i) { return i.a * i.b; }`);
    const res = await fm.executeFunc("op", JSON.stringify({ a: 4, b: 5 }));
    assert.deepEqual(res, { ok: true, value: "20" });
  });

  it("rolls back a function whose code fails to load", async () => {
    await assert.rejects(() =>
      fm.createFunc("broken", `export const notHandle = 1;`, TWO_NUMBERS, NUMBER),
    );
    assert.equal(fm.getFunc("broken"), undefined);
  });

  it("removes a function and drops it from interfaces", async () => {
    await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    await fm.createInterface("math", ["add"]);
    await fm.removeFunc("add");
    assert.deepEqual(fm.listFuncs(), []);
    assert.deepEqual(fm.getInterface("math")?.funcs, []);
    const res = await fm.executeFunc("add", "{}");
    assert.equal(res.ok, false);
  });

  it("returns structured errors instead of throwing", async () => {
    await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    // unknown function
    assert.equal((await fm.executeFunc("nope", "{}")).ok, false);
    // bad JSON
    assert.equal((await fm.executeFunc("add", "not json")).ok, false);
    // input schema mismatch
    const bad = await fm.executeFunc("add", JSON.stringify({ a: "x", b: 3 }));
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.error, /input validation/);
  });

  it("surfaces a runtime error from the function", async () => {
    await fm.createFunc(
      "boom",
      `export async function handle() { throw new Error("kaboom"); }`,
      { type: "object", properties: {} },
      NUMBER,
    );
    const res = await fm.executeFunc("boom", "{}");
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /kaboom/);
  });

  it("times out a hung function without throwing", async () => {
    const slowDir = await mkdtemp(path.join(tmpdir(), "elf-fm-slow-"));
    const slow = new FunctionManager(slowDir, { execTimeoutMs: 200 });
    await slow.start();
    try {
      await slow.createFunc(
        "hang",
        `export async function handle() { await new Promise(() => {}); }`,
        { type: "object", properties: {} },
        NUMBER,
      );
      const res = await slow.executeFunc("hang", "{}");
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, /timed out/);
    } finally {
      await slow.stop(); // terminate kills the still-running function
      await rm(slowDir, { recursive: true, force: true });
    }
  });

  describe("shared libs", () => {
    const LIB_ADD = `export const lib = { combine: (x, y) => x + y };`;
    const USES_LIB = `export async function handle(i, libs) { return libs.math.combine(i.a, i.b); }`;

    it("injects a shared lib into a function", async () => {
      await fm.createSharedLib("math", LIB_ADD);
      await fm.createFunc("calc", USES_LIB, TWO_NUMBERS, NUMBER, ["math"]);
      const res = await fm.executeFunc("calc", JSON.stringify({ a: 6, b: 1 }));
      assert.deepEqual(res, { ok: true, value: "7" });
    });

    it("hot-reloads dependents when a lib changes", async () => {
      await fm.createSharedLib("math", LIB_ADD);
      await fm.createFunc("calc", USES_LIB, TWO_NUMBERS, NUMBER, ["math"]);
      await fm.modifySharedLib("math", `export const lib = { combine: (x, y) => x * y };`);
      const res = await fm.executeFunc("calc", JSON.stringify({ a: 6, b: 7 }));
      assert.deepEqual(res, { ok: true, value: "42" });
    });

    it("refuses to remove a lib still in use", async () => {
      await fm.createSharedLib("math", LIB_ADD);
      await fm.createFunc("calc", USES_LIB, TWO_NUMBERS, NUMBER, ["math"]);
      await assert.rejects(() => fm.removeSharedLib("math"), /still used by/);
    });
  });

  describe("syscalls", () => {
    const SCHEMA_VAL: JsonSchema = {
      type: "object",
      properties: { value: { type: "number" } },
    };

    it("calls a registered syscall and returns its output", async () => {
      fm.registerSyscall(
        "double",
        SCHEMA_VAL,
        NUMBER,
        async (input) => (input as { value: number }).value * 2,
      );
      await fm.createFunc(
        "useDouble",
        `export async function handle(input) { return await sys.call("double", { value: input.value }); }`,
        SCHEMA_VAL,
        NUMBER,
      );
      const res = await fm.executeFunc("useDouble", JSON.stringify({ value: 7 }));
      assert.deepEqual(res, { ok: true, value: "14" });
    });

    it("returns a structured error when the syscall is not registered", async () => {
      await fm.createFunc(
        "badCall",
        `export async function handle() { return await sys.call("nope", {}); }`,
        { type: "object", properties: {} },
        NUMBER,
      );
      const res = await fm.executeFunc("badCall", "{}");
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, /nope/);
    });

    it("validates syscall input against its schema", async () => {
      fm.registerSyscall("double", SCHEMA_VAL, NUMBER, async (input) =>
        (input as { value: number }).value * 2,
      );
      await fm.createFunc(
        "badInput",
        `export async function handle() { return await sys.call("double", { value: "not a number" }); }`,
        { type: "object", properties: {} },
        NUMBER,
      );
      const res = await fm.executeFunc("badInput", "{}");
      assert.equal(res.ok, false);
    });

    it("validates syscall output against its schema", async () => {
      // fn returns a string but outputSchema expects a number
      fm.registerSyscall(
        "broken",
        SCHEMA_VAL,
        NUMBER,
        async () => "oops" as unknown as number,
      );
      await fm.createFunc(
        "callBroken",
        `export async function handle(input) { return await sys.call("broken", { value: input.value }); }`,
        SCHEMA_VAL,
        NUMBER,
      );
      const res = await fm.executeFunc("callBroken", JSON.stringify({ value: 1 }));
      assert.equal(res.ok, false);
    });
  });

  describe("interfaces", () => {
    beforeEach(async () => {
      await fm.createFunc("add", ADD_CODE, TWO_NUMBERS, NUMBER);
    });

    it("describes an interface with member schemas", async () => {
      await fm.createInterface("math", ["add"]);
      const desc = fm.describeInterface("math");
      assert.equal(desc.name, "math");
      assert.equal(desc.funcs.length, 1);
      assert.deepEqual(desc.funcs[0].inputSchema, TWO_NUMBERS);
    });

    it("rejects interfaces over unknown functions", async () => {
      await assert.rejects(() => fm.createInterface("bad", ["ghost"]));
    });
  });
});

describe("FunctionManager persistence", () => {
  it("restores functions, libs, and interfaces across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-fm-persist-"));
    try {
      const first = new FunctionManager(dir, { execTimeoutMs: 2000 });
      await first.start();
      await first.createSharedLib("math", `export const lib = { combine: (x, y) => x + y };`);
      await first.createFunc(
        "calc",
        `export async function handle(i, libs) { return libs.math.combine(i.a, i.b); }`,
        TWO_NUMBERS,
        NUMBER,
        ["math"],
      );
      await first.createInterface("api", ["calc"]);
      await first.stop();

      const second = new FunctionManager(dir, { execTimeoutMs: 2000 });
      await second.start();
      try {
        assert.deepEqual(second.listFuncs(), ["calc"]);
        assert.deepEqual(second.listSharedLibs(), ["math"]);
        assert.deepEqual(second.getInterface("api")?.funcs, ["calc"]);
        const res = await second.executeFunc("calc", JSON.stringify({ a: 10, b: 5 }));
        assert.deepEqual(res, { ok: true, value: "15" });
      } finally {
        await second.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
