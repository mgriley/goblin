/**
 * Worker-thread implementation of {@link FunctionExecutor}. Owns the worker(s),
 * serializes RPC over `postMessage`, correlates responses by id, and enforces
 * per-call timeouts. The {@link FunctionManager} talks to it only through the
 * {@link FunctionExecutor} interface and never touches a `Worker` directly.
 *
 * V1 runs a single worker but `exec` deliberately picks "a worker" rather than
 * "the worker", so growing into a small pool later is a local change. Two
 * caveats that shape the design:
 *   - A timeout does NOT cancel a runaway function; it only stops us waiting.
 *     The code keeps running on the worker. The only hard stop is recycling
 *     (terminate + respawn), which kills every in-flight call on that worker.
 *   - load/unload are broadcast to every worker so any worker can serve any
 *     `exec`; only `exec` is routed to a single picked worker.
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AsyncRequestTracker } from "../utils/async-request-tracker.js";
import type {
  ExecOptions,
  FuncSpec,
  FunctionExecutor,
  LibSpec,
  SystemInterface,
} from "./function_executor.js";

// The worker is plain `.mjs` (see worker.mjs for why) sitting next to this
// file — src/functions/ under tsx, dist/functions/ when compiled. Being plain
// JS, it loads identically in both without a TS loader in the worker realm.
const HERE = fileURLToPath(import.meta.url);
const WORKER_SCRIPT = path.join(path.dirname(HERE), "worker.mjs");

// ---------------------------------------------------------------------------
// Wire protocol between this main thread and the worker (worker.mjs). Every
// message is an `{ id, payload }` envelope: we assign the `id`, the worker
// echoes it back, and that pairs each reply to its request. Kept tiny and
// structured-clone-friendly (no functions, no class instances) so it survives
// `postMessage` and is trivial to reimplement in another language. worker.mjs
// mirrors these shapes in JSDoc.
//
// In addition to the normal main→worker commands, the worker can issue a
// syscall request (worker→main) which the main thread handles and replies to
// with a syscallResponse (main→worker).
// ---------------------------------------------------------------------------

/** A single instruction for the worker (the request envelope's payload). */
type RequestPayload =
  | {
      kind: "load";
      /** Function name (also its on-disk file basename). */
      name: string;
      /** Absolute path to the function's `.mjs` file. */
      path: string;
      /** Content hash of the code; a change forces a fresh re-import. */
      contentHash: string;
      /** Shared libs to import and pass to `handle` as its second argument. */
      libs: LibSpec[];
    }
  | { kind: "unload"; name: string }
  | {
      kind: "exec";
      name: string;
      /** Parsed + schema-validated input; passed straight through to `handle`. */
      input: unknown;
    };

/** The worker's reply (the response envelope's payload). */
interface ResponsePayload {
  ok: boolean;
  /** Present on a successful `exec` — the raw value `handle` returned. */
  output?: unknown;
  /** Present when `ok` is false — a human-readable error/stack string. */
  error?: string;
}

/** Worker→main: a sys.call syscall request. */
interface SystemCallRequest {
  kind: "syscall";
  callId: number;
  name: string;
  input: unknown;
}

/** Main→worker: the reply to a SystemCallRequest. */
interface SystemCallResponse {
  kind: "syscallResponse";
  callId: number;
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** Outgoing envelope: an instruction tagged with a correlation id. */
interface Request {
  id: number;
  payload: RequestPayload;
}

/** Incoming envelope: the reply tagged with the request's correlation id. */
interface Response {
  id: number;
  payload: ResponsePayload;
}

/** A single worker and the in-flight calls awaiting its replies. */
class ManagedWorker {
  private readonly worker: Worker;
  // Correlates each request to the worker's reply by id; see AsyncRequestTracker.
  private readonly tracker = new AsyncRequestTracker<RequestPayload, unknown>(
    (id, payload) => this.worker.postMessage({ id, payload } satisfies Request),
    { label: "function" },
  );

  constructor(private readonly sys: SystemInterface) {
    this.worker = new Worker(WORKER_SCRIPT);
    this.worker.on("message", (msg: Response | SystemCallRequest) => {
      // Syscall from sys.call — dispatch and reply asynchronously.
      if ((msg as SystemCallRequest).kind === "syscall") {
        void this.dispatchSystemCall(msg as SystemCallRequest);
      } else {
        this.settle(msg as Response);
      }
    });
    this.worker.on("error", (err) =>
      this.tracker.rejectAll(
        err instanceof Error ? err : new Error(String(err)),
      ),
    );
    this.worker.on("exit", () =>
      this.tracker.rejectAll(new Error("function worker exited")),
    );
  }

  private async dispatchSystemCall(msg: SystemCallRequest): Promise<void> {
    let reply: SystemCallResponse;
    try {
      const output = await this.sys.call(msg.name, msg.input);
      reply = { kind: "syscallResponse", callId: msg.callId, ok: true, output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      reply = { kind: "syscallResponse", callId: msg.callId, ok: false, error };
    }
    this.worker.postMessage(reply);
  }

  /**
   * Send a request and await the worker's reply. Rejects with the worker's
   * error string, on transport failure, or once `timeoutMs` elapses (the call
   * keeps running on the worker — see the file header).
   */
  send(payload: RequestPayload, timeoutMs?: number): Promise<unknown> {
    return this.tracker.request(payload, timeoutMs);
  }

  private settle(res: Response): void {
    if (res.payload.ok) this.tracker.resolve(res.id, res.payload.output);
    else {
      this.tracker.reject(
        res.id,
        new Error(res.payload.error ?? "unknown function error"),
      );
    }
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
    this.tracker.rejectAll(new Error("function worker terminated"));
  }
}

export class WorkerExecutor implements FunctionExecutor {
  private readonly workers: ManagedWorker[];
  private next = 0;

  constructor(workerCount = 1, sys: SystemInterface) {
    const count = Math.max(1, workerCount);
    this.workers = Array.from({ length: count }, () => new ManagedWorker(sys));
  }

  /** Load/hot-reload a function on every worker so any can serve it. */
  async loadFunc(spec: FuncSpec): Promise<void> {
    await Promise.all(
      this.workers.map((w) =>
        w.send({
          kind: "load",
          name: spec.name,
          path: spec.path,
          contentHash: spec.contentHash,
          libs: spec.libs,
        }),
      ),
    );
  }

  /** Make a function non-callable on every worker. */
  async unloadFunc(name: string): Promise<void> {
    await Promise.all(
      this.workers.map((w) => w.send({ kind: "unload", name })),
    );
  }

  /** Run a function on a picked worker, returning its raw output value. */
  async executeFunc(
    name: string,
    input: unknown,
    options?: ExecOptions,
  ): Promise<unknown> {
    return this.pick().send({ kind: "exec", name, input }, options?.timeoutMs);
  }

  /** Round-robin worker selection (trivial with a single worker). */
  private pick(): ManagedWorker {
    const worker = this.workers[this.next];
    this.next = (this.next + 1) % this.workers.length;
    return worker;
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
