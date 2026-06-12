/**
 * PortsManager — handles opening HTTP listening ports so that the Goblin can expose
 * its own HTTP server. Does so by registering `HttpPeer`s with the PeerManager.
 *
 * It is to sockets what {@link import("../spawn/spawn_manager.js").SpawnManager} is to
 * child processes: it owns the *existence* side (open a port, close one, reopen
 * the set on startup) and hands each live listener to {@link PeerManager} as an
 * {@link HttpPeer}.
 *
 * When a port is opened, PortsManager automatically creates:
 *   - a handler function `handleRequest_<name>` (default: hello-world) in
 *     FunctionManager, which receives the full HTTP request and returns a response
 *   - an interface `http_<name>` exposing that function
 *   - the peer's interface assignment pointing at `http_<name>`
 *
 * All inbound HTTP requests flow through that single function, giving the goblin
 * full control over routing, response codes, and content types. To change the
 * behaviour of a port, modify `handleRequest_<name>` via FunctionManager.
 *
 * A port is two things that persist differently:
 *   - the live server — an `http.Server` + its HttpPeer. Runtime-only; attached
 *     on {@link openPort} and dropped on {@link closePort}.
 *   - the record — `name -> { port, host }`. Durable *intent*, mirrored to
 *     `ports.json` so {@link openAllExisting} can rebuild on restart.
 *     FunctionManager and PeerManager separately persist the function/interface
 *     and peer binding, so a reopened port reapplies everything automatically.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HttpPeer } from "./http_peer.js";
import { Logger } from "../utils/logger.js";
import { assertValidPeerName, type PeerManager } from "../peers/peer_manager.js";
import type { FunctionManager } from "../functions/function_manager.js";
import type { JsonSchema } from "../utils/schema.js";

/** Where to bind a port. `host` defaults to loopback (see {@link DEFAULT_HOST}). */
export interface OpenPortOptions {
  port: number;
  host?: string;
}

/** Loopback by default — facing the network (`0.0.0.0`) must be opted into. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * Input schema for the HTTP handler function.
 * All fields are strings; `headers` is a JSON-encoded object.
 */
const REQUEST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    method: { type: "string", description: "HTTP verb (GET, POST, …)" },
    path: { type: "string", description: "URL path, percent-decoded, no query string" },
    query: { type: "map", values: { type: "string" }, description: "Parsed query parameters (string → string)" },
    headers: { type: "map", values: { type: "string" }, description: "Request headers (string → string)" },
    body: { type: "string", description: "Request body as UTF-8 text, empty string if none" },
  },
};

/** Output schema for the HTTP handler function. */
const RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "integer", description: "HTTP status code" },
    contentType: { type: "string", description: "Content-Type header value" },
    body: { type: "string", description: "Response body as UTF-8 text" },
  },
};

/** Default handler installed when a port is first opened. */
const DEFAULT_HANDLER_CODE = `\
export async function handle(input) {
  return {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body: "Hello from Goblin!",
  };
}
`;

function handlerFuncName(portName: string): string {
  return `handleRequest_${portName}`;
}

function httpInterfaceName(portName: string): string {
  return `http_${portName}`;
}

/** A port record: durable bind info plus, when open, the live server. */
interface PortEntry {
  name: string;
  port: number;
  host: string;
  server?: Server;
}

/** On-disk shape of `ports.json`: just the durable bind info per port. */
interface PortStore {
  ports: Record<string, { port: number; host: string }>;
}

export class PortsManager {
  private readonly ports = new Map<string, PortEntry>();
  private readonly storePath: string;
  private started = false;

  constructor(
    private readonly rootDir: string,
    private readonly peerManager: PeerManager,
    private readonly functionManager: FunctionManager,
  ) {
    this.storePath = path.join(rootDir, "ports.json");
  }

  /** Restore persisted port records from disk. Call once before other methods. */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.rootDir, { recursive: true });
    await this.restore();
    this.started = true;
  }

  /**
   * Open a listening HTTP port under `name`. Automatically creates
   * `handleRequest_<name>` and `http_<name>` in FunctionManager if they don't
   * already exist (they survive restarts, so this is a no-op for known ports).
   * Binds before attaching, so a bind failure throws without leaving a phantom
   * peer. Throws if `name` is already listening.
   */
  async openPort(name: string, options: OpenPortOptions): Promise<void> {
    assertValidPeerName(name);
    if (this.ports.get(name)?.server) {
      throw new Error(`openPort: "${name}" is already listening`);
    }

    // Ensure the handler function + interface exist. Idempotent across restarts
    // because FunctionManager persists them independently.
    const funcName = handlerFuncName(name);
    const ifaceName = httpInterfaceName(name);
    if (!this.functionManager.getFunc(funcName)) {
      await this.functionManager.createFunc(funcName, DEFAULT_HANDLER_CODE, REQUEST_SCHEMA, RESPONSE_SCHEMA);
    }
    if (!this.functionManager.getInterface(ifaceName)) {
      await this.functionManager.createInterface(ifaceName, [funcName]);
    }

    const host = options.host ?? DEFAULT_HOST;
    const server = createServer();
    await listen(server, options.port, host);

    await this.peerManager.attachPeer(name, (callbacks) => new HttpPeer(server, callbacks, funcName));
    await this.peerManager.setPeerInterface(name, ifaceName);

    // Record the *actual* bound port — `options.port: 0` resolves to an ephemeral
    // one, and we want the real value persisted and reported.
    const boundPort = actualPort(server) ?? options.port;
    this.ports.set(name, { name, port: boundPort, host, server });
    await this.persist();
    Logger.logEvent({ category: "port", action: "opened", target: name, details: { host, port: boundPort } });
  }

  /**
   * Bring up every persisted port that isn't already listening. Called on startup
   * to resume where we left off; FunctionManager and PeerManager reapply each
   * one's function/interface/binding automatically.
   */
  async openAllExisting(): Promise<void> {
    for (const entry of [...this.ports.values()]) {
      if (entry.server) continue;
      await this.openPort(entry.name, { port: entry.port, host: entry.host });
    }
  }

  /**
   * Stop listening on `name` but keep its record, the peer's interface binding,
   * and the handler function, so a later {@link openPort} or
   * {@link openAllExisting} restores everything. No-op if not currently listening.
   */
  closePort(name: string): void {
    const entry = this.ports.get(name);
    if (!entry?.server) return;
    entry.server = undefined;
    this.peerManager.detachPeer(name);
    Logger.logEvent({ category: "port", action: "closed", target: name });
  }

  /**
   * Forget a port entirely: stop listening, drop the peer, and remove the
   * auto-created handler function and interface.
   */
  async removePort(name: string): Promise<void> {
    this.closePort(name);
    if (!this.ports.delete(name)) return;
    await this.peerManager.removePeer(name);
    await this.functionManager.removeInterface(httpInterfaceName(name));
    await this.functionManager.removeFunc(handlerFuncName(name));
    await this.persist();
    Logger.logEvent({ category: "port", action: "removed", target: name });
  }

  /** Names of ports currently listening. */
  listListening(): string[] {
    return [...this.ports.values()].filter((e) => e.server).map((e) => e.name);
  }

  /** The bound port number for `name`, or undefined if unknown / not listening. */
  getPort(name: string): number | undefined {
    const entry = this.ports.get(name);
    return entry?.server ? entry.port : undefined;
  }

  private async persist(): Promise<void> {
    const store: PortStore = { ports: {} };
    for (const entry of this.ports.values()) {
      store.ports[entry.name] = { port: entry.port, host: entry.host };
    }
    await writeFile(this.storePath, JSON.stringify(store, null, 2));
  }

  private async restore(): Promise<void> {
    let store: PortStore;
    try {
      store = JSON.parse(await readFile(this.storePath, "utf8")) as PortStore;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return; // fresh goblin
      throw err;
    }
    for (const [name, meta] of Object.entries(store.ports ?? {})) {
      this.ports.set(name, { name, port: meta.port, host: meta.host });
    }
  }
}

/** Resolve when the server is listening; reject if the bind fails. */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** The actual bound TCP port, or undefined if not an AF_INET/6 socket. */
function actualPort(server: Server): number | undefined {
  const addr = server.address();
  return addr && typeof addr === "object" ? addr.port : undefined;
}
