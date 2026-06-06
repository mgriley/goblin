/**
 * The `sys` namespace — available at module scope in every user function via
 * `globalThis.sys` (set by worker.mjs at startup). Owns the syscall state
 * for invoking functions registered on the main-thread FunctionManager.
 *
 * Plain JS (not TS) for the same reason as worker.mjs: no TS loader in the
 * worker realm. The build copies this file to dist/functions/ verbatim.
 */
import { parentPort } from "node:worker_threads";

const pending = new Map(); // callId -> { resolve, reject }
let nextId = 0;

export const sys = {
  /** Make a system call to the main-thread FunctionManager. Input/output are validated there. */
  call(name, input) {
    return new Promise((resolve, reject) => {
      const callId = nextId++;
      pending.set(callId, { resolve, reject });
      try {
        parentPort.postMessage({ kind: "syscall", callId, name, input });
      } catch (err) {
        // postMessage throws if input isn't structured-clone-friendly; clean up
        // the pending entry so the promise rejects immediately instead of hanging.
        pending.delete(callId);
        reject(err);
      }
    });
  },
};

/** Route a syscallResponse from the main thread to the waiting promise. */
export function handleSystemCallResponse(msg) {
  const p = pending.get(msg.callId);
  if (!p) return;
  pending.delete(msg.callId);
  msg.ok
    ? p.resolve(msg.output)
    : p.reject(new Error(msg.error ?? "system call failed"));
}
