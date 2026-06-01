/**
 * The function-execution worker. One (eventually a small pool) runs per elf.
 *
 * Deliberately plain JavaScript (`.mjs`), not TypeScript: it is spawned as a
 * worker thread and must load identically under tsx (dev) and from `dist`
 * (prod) without depending on a TS loader being present in the worker realm —
 * which Node does not propagate into worker threads. The build copies this file
 * into `dist/functions/` verbatim. The wire-protocol shapes it speaks are
 * defined (and type-checked on the main-thread side) in `worker_executor.ts`.
 *
 * Why a worker at all: it is its own realm, so user function code loaded here
 * can never block the elf's event loop or its IPC with parent/children. The
 * realm is also the unit of unload — the only way to truly reclaim memory from
 * imported modules is to terminate this worker and respawn it (see
 * WorkerExecutor). Functions live as `.mjs` files on disk and are pulled in
 * with a `?v=<contentHash>` query so a code change re-imports fresh module text
 * (Node's module cache is keyed by URL with no eviction API — a new query
 * string is a new key). The old version stays resident until the worker is
 * recycled; that's an accepted tradeoff for cheap hot-reload.
 *
 * @typedef {{ name: string, path: string, contentHash: string }} LibSpec
 * @typedef {(
 *   | { kind: "load", name: string, path: string, contentHash: string, libs: LibSpec[] }
 *   | { kind: "unload", name: string }
 *   | { kind: "exec", name: string, input: unknown }
 * )} RequestPayload
 * @typedef {{ id: number, payload: RequestPayload }} Request
 */

import { parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

if (!parentPort) {
  throw new Error("function worker must be started as a worker thread");
}
const port = parentPort;

/** name -> { handle, libs } for every currently-loaded function. */
const loaded = new Map();

port.on("message", (/** @type {Request} */ req) => {
  handle(req.payload).then(
    (output) => port.postMessage({ id: req.id, payload: { ok: true, output } }),
    (err) =>
      port.postMessage({
        id: req.id,
        payload: { ok: false, error: errorText(err) },
      }),
  );
});

/** @param {RequestPayload} payload */
async function handle(payload) {
  switch (payload.kind) {
    case "load": {
      const libs = {};
      for (const spec of payload.libs) {
        libs[spec.name] = await importLib(spec);
      }
      const mod = await import(versioned(payload.path, payload.contentHash));
      if (typeof mod.handle !== "function") {
        throw new Error(
          `function "${payload.name}" must export a "handle" function`,
        );
      }
      loaded.set(payload.name, { handle: mod.handle, libs });
      return undefined;
    }
    case "unload":
      loaded.delete(payload.name);
      return undefined;
    case "exec": {
      const entry = loaded.get(payload.name);
      if (!entry) throw new Error(`function "${payload.name}" is not loaded`);
      return await entry.handle(payload.input, entry.libs);
    }
    default:
      throw new Error(
        `unknown request kind: ${/** @type {any} */ (payload).kind}`,
      );
  }
}

/**
 * Import a shared lib's `.mjs` file and return its exported `lib` value.
 * @param {LibSpec} spec
 */
async function importLib(spec) {
  const mod = await import(versioned(spec.path, spec.contentHash));
  if (!("lib" in mod)) {
    throw new Error(`shared lib "${spec.name}" must export a "lib" value`);
  }
  return mod.lib;
}

/**
 * Build a cache-busted import URL: the `?v=<hash>` query makes a code change a
 * new module-cache key, while identical code reuses the cached module.
 * @param {string} filePath
 * @param {string} contentHash
 */
function versioned(filePath, contentHash) {
  return `${pathToFileURL(filePath).href}?v=${contentHash}`;
}

/** @param {unknown} err */
function errorText(err) {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
