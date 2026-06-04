/**
 * PortsManager — the listening ports this elf serves on.
 *
 * It is to sockets what {@link import("./spawn_manager.js").SpawnManager} is to
 * child processes: it owns the *existence* side (open a port, close one, reopen
 * the set on startup) and hands each live listener to {@link PeerManager} as an
 * {@link HttpPeer}. Like SpawnManager, it knows nothing about interfaces — the
 * binding (and its persistence) stays in PeerManager. Opening a port is therefore
 * all it takes for an elf to act like a server: inbound HTTP requests flow through
 * the same `invokeFunction` gate as any other peer.
 *
 * A port is two things that persist differently, mirroring a peer:
 *   - the live server — an `http.Server` + its HttpPeer. Runtime-only; attached on
 *     {@link openPort} and dropped on {@link closePort}.
 *   - the record — `name -> { port, host }`. Durable *intent* ("serve `publicApi`
 *     on :8080"), mirrored to `ports.json` so {@link openAllExisting} can rebuild
 *     the set after a restart. PeerManager separately remembers the interface, so
 *     a reopened port reapplies its API surface automatically.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HttpPeer } from "./http_peer.js";
import { assertValidPeerName, type PeerManager } from "./peer_manager.js";

/** Where to bind a port. `host` defaults to loopback (see {@link DEFAULT_HOST}). */
export interface OpenPortOptions {
  port: number;
  host?: string;
}

/** Loopback by default — facing the network (`0.0.0.0`) must be opted into. */
const DEFAULT_HOST = "127.0.0.1";

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
   * Open a listening HTTP port under `name`, registering it as a peer so its
   * assigned interface governs what callers can reach. Binds before attaching, so
   * a bind failure (e.g. port in use) throws without leaving a phantom peer.
   * Persists the record on success. Throws if `name` is already listening.
   */
  async openPort(name: string, options: OpenPortOptions): Promise<void> {
    assertValidPeerName(name);
    if (this.ports.get(name)?.server) {
      throw new Error(`openPort: "${name}" is already listening`);
    }
    const host = options.host ?? DEFAULT_HOST;
    const server = createServer();
    await listen(server, options.port, host);

    // Now that the socket is bound, wire it as a peer. Routing the HttpPeer
    // factory through PeerManager binds inbound requests to access control for
    // `name`, exactly as SpawnManager does for an IpcPeer.
    await this.peerManager.attachPeer(name, (callbacks) => new HttpPeer(server, callbacks));

    // Record the *actual* bound port — `options.port: 0` resolves to an ephemeral
    // one, and we want the real value persisted and reported.
    const boundPort = actualPort(server) ?? options.port;
    this.ports.set(name, { name, port: boundPort, host, server });
    await this.persist();
  }

  /**
   * Bring up every persisted port that isn't already listening. Called on startup
   * to resume where we left off; PeerManager reapplies each one's interface.
   */
  async openAllExisting(): Promise<void> {
    for (const entry of [...this.ports.values()]) {
      if (entry.server) continue;
      await this.openPort(entry.name, { port: entry.port, host: entry.host });
    }
  }

  /**
   * Stop listening on `name` but keep its record + the peer's interface, so a
   * later {@link openPort} (or {@link openAllExisting}) reapplies both. No-op if
   * not currently listening.
   */
  closePort(name: string): void {
    const entry = this.ports.get(name);
    if (!entry?.server) return;
    entry.server = undefined; // dropped before close so it reads as not-listening
    this.peerManager.detachPeer(name); // closes the HttpPeer, which closes the server
  }

  /** Forget a port entirely: stop listening, drop the peer, erase the record. */
  async removePort(name: string): Promise<void> {
    this.closePort(name);
    if (!this.ports.delete(name)) return;
    await this.peerManager.removePeer(name);
    await this.persist();
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
      if ((err as { code?: string }).code === "ENOENT") return; // fresh elf
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
