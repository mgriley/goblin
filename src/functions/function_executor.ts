/**
 * The execution backend contract. A {@link FunctionExecutor} owns however
 * functions actually run — loading their code, invoking them, and tearing the
 * backend down — while the {@link FunctionManager} stays agnostic about the
 * mechanism. {@link WorkerExecutor} (worker-thread based) is the only
 * implementation today; this seam lets us swap in others later (e.g. an
 * in-process executor for tests, a subprocess pool, or a remote runner) without
 * touching the manager.
 *
 * All inputs/outputs here are already-validated plain values and structured
 * clone-friendly specs, so an implementation can live in another thread,
 * process, or machine.
 */

/** A shared lib a function depends on, identified by name + versioned file. */
export interface LibSpec {
  name: string;
  /** Absolute path to the shared lib's `.mjs` file. */
  path: string;
  /** Content hash of the lib's code; a change forces a fresh import. */
  contentHash: string;
}

/** Everything an executor needs to load a function: its file plus its libs. */
export interface FuncSpec {
  name: string;
  /** Absolute path to the function's `.mjs` file. */
  path: string;
  /** Content hash of the function's code; a change forces a fresh import. */
  contentHash: string;
  /** Shared libs the function depends on. */
  libs: LibSpec[];
}

/** Per-call options for {@link FunctionExecutor.executeFunc}. */
export interface ExecOptions {
  /** Reject the call if it hasn't completed within this many milliseconds. */
  timeoutMs?: number;
}

/** The host-side interface passed to executors so worker code can call back into the elf. */
export interface SystemInterface {
  call(name: string, input: unknown): Promise<unknown>;
}

export interface FunctionExecutor {
  /** Load or hot-reload a function so it becomes callable via {@link executeFunc}. */
  loadFunc(spec: FuncSpec): Promise<void>;

  /** Make a previously-loaded function non-callable. */
  unloadFunc(name: string): Promise<void>;

  /**
   * Run a loaded function with an already-validated input value, returning its
   * raw output. Rejects on unknown/failed function or once the configured
   * `timeoutMs` elapses.
   */
  executeFunc(
    name: string,
    input: unknown,
    options?: ExecOptions,
  ): Promise<unknown>;

  /** Tear the backend down, rejecting any in-flight calls. */
  terminate(): Promise<void>;
}
