/**
 * FunctionManager — an goblin's mini library of self-contained micro-functions.
 *
 * The mental model: an goblin authors small functions, groups them into named
 * "interfaces", and exposes an interface to a peer to grant exactly that set of
 * callable functions. Functions may pull in shared "libs" for reuse.
 *
 * Three kinds of thing, each with a consistent create/remove/modify/get verb
 * set:
 *   - functions: a single `handle(input, libs)` with input/output JSON schemas
 *   - interfaces: named groups of functions advertised to peers
 *   - shared libs: a module exporting a single `lib` value, injected into funcs
 *
 * Persistence: in-memory maps are the source of truth at runtime; every change
 * is mirrored to disk so an goblin restores its full function state on restart.
 * Layout under `rootDir`:
 *   funcs/<name>.mjs   function code
 *   libs/<name>.mjs    shared-lib code
 *   functions.json     schemas, func→lib links, interface membership
 *
 * Execution is delegated to a {@link WorkerExecutor} (a long-lived worker), so
 * user code never blocks the goblin. The cache-busting version of each function/
 * lib is the hash of its code (derived on load, never persisted), so a code
 * change forces a fresh dynamic `import` with no version tracking.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validate, type JsonSchema } from "../utils/schema.js";
import { hashContent, type Result } from "../utils/utils.js";
import { Logger } from "../utils/logger.js";
import type { FunctionExecutor, FuncSpec, SystemInterface } from "./function_executor.js";
import { WorkerExecutor } from "./worker_executor.js";

/** A single callable function. `code` is the source of its `<name>.mjs` file. */
export interface FuncDef {
  name: string;
  code: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Names of shared libs passed to `handle` as its second argument. */
  sharedLibs: string[];
}

/** A module exporting a single `lib` value, reusable across functions. */
export interface SharedLibDef {
  name: string;
  code: string;
}

/** A named group of functions exposed to a peer as a callable surface. */
export interface InterfaceDef {
  name: string;
  funcs: string[];
}

/**
 * The peer-facing description of an interface: each function's name and its
 * input/output schemas. This is the wire format advertised to a peer — schemas
 * are already plain JSON, so there's no separate serialization step.
 */
export interface InterfaceDescription {
  name: string;
  funcs: {
    name: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
  }[];
}

/** A host-provided function callable from user functions via `sys.call`. */
interface SyscallDef {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  fn: (input: unknown) => Promise<unknown>;
}

/** Public description of a syscall — schemas only, no implementation. */
export interface SyscallInfo {
  name: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

/** Structured result of {@link FunctionManager.executeFunc} — JSON output text. */
export type ExecResult = Result<string>;

/**
 * On-disk manifest. Code lives in sibling `.mjs` files, not here, and a
 * function/lib's cache-busting version is the hash of that code — derived on
 * load, never persisted.
 */
interface Manifest {
  funcs: Record<
    string,
    {
      inputSchema: JsonSchema;
      outputSchema: JsonSchema;
      sharedLibs: string[];
    }
  >;
  /** Shared lib names; each lib's code lives in `libs/<name>.mjs`. */
  libs: string[];
  interfaces: Record<string, { funcs: string[] }>;
}

export interface FunctionManagerOptions {
  /** Per-call execution timeout in ms. Default 30s. */
  execTimeoutMs?: number;
  /** Number of execution workers. V1 default is 1. */
  workerCount?: number;
  /**
   * Build the execution backend. Defaults to a worker-thread
   * {@link WorkerExecutor}; override to swap in a different
   * {@link FunctionExecutor} (e.g. in-process for tests, or a remote runner).
   */
  createExecutor?: (workerCount: number, sys: SystemInterface) => FunctionExecutor;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

// Names double as filenames and as identifiers in generated import URLs, so
// keep them to a safe, portable subset.
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class FunctionManager {
  private readonly funcs = new Map<string, FuncDef>();
  private readonly libs = new Map<string, SharedLibDef>();
  private readonly interfaces = new Map<string, InterfaceDef>();
  private readonly syscalls = new Map<string, SyscallDef>();

  private readonly funcsDir: string;
  private readonly libsDir: string;
  private readonly manifestPath: string;
  private readonly execTimeoutMs: number;
  private readonly workerCount: number;
  private readonly createExecutor: (
    workerCount: number,
    sys: SystemInterface,
  ) => FunctionExecutor;

  // Set in start(); the manager is unusable until then.
  private executor!: FunctionExecutor;
  private started = false;

  constructor(
    private readonly rootDir: string,
    opts: FunctionManagerOptions = {},
  ) {
    this.funcsDir = path.join(rootDir, "funcs");
    this.libsDir = path.join(rootDir, "libs");
    this.manifestPath = path.join(rootDir, "functions.json");
    this.execTimeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.workerCount = opts.workerCount ?? 1;
    this.createExecutor =
      opts.createExecutor ?? ((count, sys) => new WorkerExecutor(count, sys));
  }

  /**
   * Restore persisted state from disk, spin up the executor, and load every
   * function into it. Call once before any other method.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.funcsDir, { recursive: true });
    await mkdir(this.libsDir, { recursive: true });
    await this.restore();

    const sys: SystemInterface = { call: (name, input) => this.handleSyscall(name, input) };
    this.executor = this.createExecutor(this.workerCount, sys);
    for (const record of this.funcs.values()) {
      await this.loadFunc(record);
    }
    this.started = true;
  }

  /** Terminate the executor's worker(s). The on-disk state is left intact. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.executor.terminate();
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  /**
   * Create a new function from `code` (which must export an async
   * `handle(input, libs)`). Validates by loading it into the worker; if that
   * fails the function is rolled back so a broken function is never persisted.
   */
  async createFunc(
    name: string,
    code: string,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    sharedLibs: string[] = [],
  ): Promise<void> {
    assertValidName(name);
    if (this.funcs.has(name)) {
      throw new Error(`function "${name}" already exists`);
    }
    for (const lib of sharedLibs) this.requireLib(lib);

    const record: FuncDef = {
      name,
      code,
      inputSchema,
      outputSchema,
      sharedLibs: [...sharedLibs],
    };
    await writeFile(this.funcPath(name), code);
    this.funcs.set(name, record);
    try {
      await this.loadFunc(record);
    } catch (err) {
      this.funcs.delete(name);
      await rm(this.funcPath(name), { force: true });
      throw err;
    }
    await this.persist();
    Logger.logEvent({ category: "func", action: "created", target: name, details: { code } });
  }

  /** Replace a function's code, hot-reloading it. Rolls back on load failure. */
  async modifyFunc(name: string, newCode: string): Promise<void> {
    const record = this.requireFunc(name);
    const prevCode = record.code;

    record.code = newCode;
    await writeFile(this.funcPath(name), newCode);
    try {
      await this.loadFunc(record);
    } catch (err) {
      record.code = prevCode;
      await writeFile(this.funcPath(name), prevCode);
      throw err;
    }
    await this.persist();
    Logger.logEvent({ category: "func", action: "modified", target: name, details: { code: newCode } });
  }

  /** Remove a function and drop it from any interface that listed it. */
  async removeFunc(name: string): Promise<void> {
    if (!this.funcs.has(name)) return;
    await this.executor.unloadFunc(name);
    this.funcs.delete(name);
    await rm(this.funcPath(name), { force: true });
    for (const iface of this.interfaces.values()) {
      iface.funcs = iface.funcs.filter((f) => f !== name);
    }
    await this.persist();
    Logger.logEvent({ category: "func", action: "removed", target: name });
  }

  getFunc(name: string): FuncDef | undefined {
    const record = this.funcs.get(name);
    return record ? toFuncDef(record) : undefined;
  }

  listFuncs(): string[] {
    return [...this.funcs.keys()];
  }

  /**
   * Execute a function. `inputData` is JSON text (empty string ≡ `null`); it is
   * parsed and validated against the input schema, the result is validated
   * against the output schema, and the output is returned as JSON text. Never
   * throws — failures (unknown func, bad JSON, schema mismatch, runtime error,
   * timeout) come back as `{ ok: false, error }` so a cross-peer call degrades
   * gracefully instead of hanging or blowing up the caller.
   */
  async executeFunc(name: string, inputData: string): Promise<ExecResult> {
    const record = this.funcs.get(name);
    if (!record) return { ok: false, error: `no function named "${name}"` };

    let parsed: unknown;
    try {
      parsed = inputData.trim() === "" ? null : JSON.parse(inputData);
    } catch {
      return { ok: false, error: "input is not valid JSON" };
    }

    let input: unknown;
    try {
      input = validate(record.inputSchema, parsed);
    } catch (err) {
      return { ok: false, error: `input validation failed: ${message(err)}` };
    }

    let raw: unknown;
    try {
      raw = await this.executor.executeFunc(name, input, {
        timeoutMs: this.execTimeoutMs,
      });
    } catch (err) {
      return { ok: false, error: message(err) };
    }

    let output: unknown;
    try {
      output = validate(record.outputSchema, raw);
    } catch (err) {
      return { ok: false, error: `output validation failed: ${message(err)}` };
    }
    return { ok: true, value: JSON.stringify(output) };
  }

  // -------------------------------------------------------------------------
  // Interfaces
  // -------------------------------------------------------------------------

  /** Create an interface grouping existing functions. */
  async createInterface(name: string, funcs: string[]): Promise<void> {
    assertValidName(name);
    if (this.interfaces.has(name)) {
      throw new Error(`interface "${name}" already exists`);
    }
    for (const f of funcs) this.requireFunc(f);
    this.interfaces.set(name, { name, funcs: [...funcs] });
    await this.persist();
    Logger.logEvent({ category: "func", action: "created interface", target: name, details: { funcs } });
  }

  /** Replace the function membership of an interface. */
  async modifyInterface(name: string, newFuncs: string[]): Promise<void> {
    const iface = this.interfaces.get(name);
    if (!iface) throw new Error(`no interface named "${name}"`);
    for (const f of newFuncs) this.requireFunc(f);
    iface.funcs = [...newFuncs];
    await this.persist();
    Logger.logEvent({ category: "func", action: "modified interface", target: name, details: { funcs: newFuncs } });
  }

  async removeInterface(name: string): Promise<void> {
    if (!this.interfaces.delete(name)) return;
    await this.persist();
    Logger.logEvent({ category: "func", action: "removed interface", target: name });
  }

  getInterface(name: string): InterfaceDef | undefined {
    const iface = this.interfaces.get(name);
    return iface ? { name: iface.name, funcs: [...iface.funcs] } : undefined;
  }

  listInterfaces(): string[] {
    return [...this.interfaces.keys()];
  }

  /**
   * The peer-facing description of an interface: its functions' names and
   * schemas, ready to advertise to a peer. Throws if the interface is unknown.
   */
  describeInterface(name: string): InterfaceDescription {
    const iface = this.interfaces.get(name);
    if (!iface) throw new Error(`no interface named "${name}"`);
    return {
      name: iface.name,
      funcs: iface.funcs.map((funcName) => {
        const record = this.requireFunc(funcName);
        return {
          name: record.name,
          inputSchema: record.inputSchema,
          outputSchema: record.outputSchema,
        };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Shared libs
  // -------------------------------------------------------------------------

  /** Create a shared lib (a module exporting a single `lib` value). */
  async createSharedLib(name: string, code: string): Promise<void> {
    assertValidName(name);
    if (this.libs.has(name)) {
      throw new Error(`shared lib "${name}" already exists`);
    }
    await writeFile(this.libPath(name), code);
    this.libs.set(name, { name, code });
    await this.persist();
    Logger.logEvent({ category: "func", action: "created lib", target: name, details: { code } });
  }

  /** Replace a shared lib's code, hot-reloading every function that uses it. */
  async modifySharedLib(name: string, newCode: string): Promise<void> {
    const lib = this.requireLib(name);
    lib.code = newCode;
    await writeFile(this.libPath(name), newCode);
    for (const record of this.funcs.values()) {
      if (record.sharedLibs.includes(name)) await this.loadFunc(record);
    }
    await this.persist();
    Logger.logEvent({ category: "func", action: "modified lib", target: name, details: { code: newCode } });
  }

  /** Remove a shared lib. Fails if any function still depends on it. */
  async removeSharedLib(name: string): Promise<void> {
    if (!this.libs.has(name)) return;
    const dependents = [...this.funcs.values()]
      .filter((f) => f.sharedLibs.includes(name))
      .map((f) => f.name);
    if (dependents.length > 0) {
      throw new Error(
        `cannot remove shared lib "${name}"; still used by: ${dependents.join(", ")}`,
      );
    }
    this.libs.delete(name);
    await rm(this.libPath(name), { force: true });
    await this.persist();
    Logger.logEvent({ category: "func", action: "removed lib", target: name });
  }

  /** Set the shared libs a function receives, reloading it. Rolls back on failure. */
  async setFuncSharedLibs(funcName: string, libNames: string[]): Promise<void> {
    const record = this.requireFunc(funcName);
    for (const lib of libNames) this.requireLib(lib);
    const prev = record.sharedLibs;
    record.sharedLibs = [...libNames];
    try {
      await this.loadFunc(record);
    } catch (err) {
      record.sharedLibs = prev;
      await this.loadFunc(record).catch(() => {});
      throw err;
    }
    await this.persist();
  }

  getSharedLib(name: string): SharedLibDef | undefined {
    const lib = this.libs.get(name);
    return lib ? { name: lib.name, code: lib.code } : undefined;
  }

  listSharedLibs(): string[] {
    return [...this.libs.keys()];
  }

  // -------------------------------------------------------------------------
  // System calls
  // -------------------------------------------------------------------------

  /**
   * Register a host-provided function callable from user code via `sys.call(name, input)`.
   * Input and output are validated against the supplied schemas, same as regular functions.
   * 
   * These registrations are not persisted. The expectation is that the goblin's main script
   * registers all the syscalls on startup.
   */
  registerSyscall(
    name: string,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    fn: (input: unknown) => Promise<unknown>,
  ): void {
    this.syscalls.set(name, { inputSchema, outputSchema, fn });
  }

  /** Return the name and schemas of every registered syscall. */
  listSyscalls(): SyscallInfo[] {
    return [...this.syscalls.entries()].map(([name, def]) => ({
      name,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
    }));
  }

  /** Validate input, invoke the syscall handler, validate output. */
  private async handleSyscall(name: string, input: unknown): Promise<unknown> {
    const def = this.syscalls.get(name);
    if (!def) throw new Error(`no syscall "${name}"`);
    const validInput = validate(def.inputSchema, input);
    const output = await def.fn(validInput);
    return validate(def.outputSchema, output);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a function's load spec (resolving its libs) and send it to the
   * executor. The cache-busting version is the hash of the code, so a code
   * change naturally forces a fresh import without any version tracking.
   */
  private async loadFunc(record: FuncDef): Promise<void> {
    const spec: FuncSpec = {
      name: record.name,
      path: this.funcPath(record.name),
      contentHash: hashContent(record.code),
      libs: record.sharedLibs.map((libName) => {
        const lib = this.requireLib(libName);
        return {
          name: libName,
          path: this.libPath(libName),
          contentHash: hashContent(lib.code),
        };
      }),
    };
    await this.executor.loadFunc(spec);
  }

  private requireFunc(name: string): FuncDef {
    const record = this.funcs.get(name);
    if (!record) throw new Error(`no function named "${name}"`);
    return record;
  }

  private requireLib(name: string): SharedLibDef {
    const lib = this.libs.get(name);
    if (!lib) throw new Error(`no shared lib named "${name}"`);
    return lib;
  }

  private funcPath(name: string): string {
    return path.join(this.funcsDir, `${name}.mjs`);
  }

  private libPath(name: string): string {
    return path.join(this.libsDir, `${name}.mjs`);
  }

  private async persist(): Promise<void> {
    const manifest: Manifest = { funcs: {}, libs: [], interfaces: {} };
    for (const f of this.funcs.values()) {
      manifest.funcs[f.name] = {
        inputSchema: f.inputSchema,
        outputSchema: f.outputSchema,
        sharedLibs: f.sharedLibs,
      };
    }
    manifest.libs = [...this.libs.keys()];
    for (const i of this.interfaces.values()) {
      manifest.interfaces[i.name] = { funcs: i.funcs };
    }
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  private async restore(): Promise<void> {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, "utf8")) as Manifest;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return; // fresh goblin
      throw err;
    }

    for (const name of manifest.libs ?? []) {
      const code = await readFile(this.libPath(name), "utf8");
      this.libs.set(name, { name, code });
    }
    for (const [name, meta] of Object.entries(manifest.funcs ?? {})) {
      const code = await readFile(this.funcPath(name), "utf8");
      this.funcs.set(name, {
        name,
        code,
        inputSchema: meta.inputSchema,
        outputSchema: meta.outputSchema,
        sharedLibs: meta.sharedLibs ?? [],
      });
    }
    for (const [name, meta] of Object.entries(manifest.interfaces ?? {})) {
      this.interfaces.set(name, { name, funcs: meta.funcs ?? [] });
    }
  }
}

function toFuncDef(record: FuncDef): FuncDef {
  return {
    name: record.name,
    code: record.code,
    inputSchema: record.inputSchema,
    outputSchema: record.outputSchema,
    sharedLibs: [...record.sharedLibs],
  };
}

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `invalid name "${name}": must match ${VALID_NAME} (used as a filename)`,
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
