/**
 * PeerManager — the edges in/out of this goblin, and who may call what.
 *
 * Each peer is assigned at most one interface (a named group of functions; see
 * FunctionManager). A peer may call only the functions in its assigned
 * interface — enforcing that is this manager's reason to exist.
 *
 * A peer is two things glued together, and they persist very differently:
 *   - the live connection — an {@link AbstractPeer} wrapping an IPC channel.
 *     Inherently runtime-only; you can't serialize a forked process. Attached
 *     when something brings the peer up (see SpawnManager) and dropped on exit.
 *   - the binding — `peerName -> interfaceName`. This is durable *intent*: the
 *     goblin decided "child `auth` gets interface `db`", and that survives a
 *     restart. Only this thin map is mirrored to `peers.json`.
 *
 * So a peer record can exist with no live connection (known-but-disconnected):
 * when the connection re-attaches, its remembered interface applies again. This
 * mirrors FunctionManager's "in-memory source of truth, mirrored to disk" shape.
 *
 * Process *existence* (which children to respawn) is SpawnManager's concern, not
 * this manager's — the two reference each other only by peer name.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Result } from "../utils/utils.js";
import type { InterfaceDescription } from "../functions/function_manager.js";
import { Logger } from "../utils/logger.js";
import { AbstractPeer, type CallResult, type PeerManagerHandle } from "./peer.js";

/**
 * The slice of FunctionManager that PeerManager needs: look up an interface's
 * member functions, and execute one. FunctionManager satisfies this structurally
 * — the narrow port keeps `peers/` decoupled from function internals (and easy
 * to fake in tests).
 */
export interface FunctionGateway {
  /** Member function names of an interface, or undefined if it doesn't exist. */
  getInterface(name: string): { funcs: string[] } | undefined;
  /** The peer-facing description of an interface (names + schemas). */
  describeInterface(name: string): InterfaceDescription;
  /** Execute a function by name with JSON input text; never throws. */
  executeFunc(funcName: string, inData: string): Promise<Result<string>>;
}

/** A peer record: its remembered interface plus, when up, a live connection. */
interface PeerEntry {
  name: string;
  /** Assigned interface, or null if none is bound yet. */
  interfaceName: string | null;
  /** The live transport, present only while the peer is connected. */
  connection?: AbstractPeer;
}

/** Read-only view of a peer for callers outside the manager. */
export interface PeerView {
  name: string;
  interfaceName: string | null;
  connected: boolean;
}

/** On-disk shape of `peers.json`: just the durable bindings. */
interface PeerStore {
  peers: Record<string, { interface: string | null }>;
}

// Peer names double as keys in `peers.json` and as ids elsewhere; keep them to
// a safe, portable subset (same rule FunctionManager uses for filenames).
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class PeerManager {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly storePath: string;
  private started = false;

  constructor(
    private readonly rootDir: string,
    private readonly gateway: FunctionGateway,
  ) {
    this.storePath = path.join(rootDir, "peers.json");
  }

  /** Restore persisted bindings from disk. Call once before other methods. */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.rootDir, { recursive: true });
    await this.restore();
    this.started = true;
  }

  /**
   * Adopt a live connection for `name`, creating the peer record if it is new.
   * The transport is built via `create`, which receives the access-control
   * callbacks bound to this peer — routing the factory through here guarantees
   * inbound calls can't bypass the interface check. A remembered interface (from
   * a prior run) carries over automatically. Closes any previous connection.
   */
  async attachPeer(
    name: string,
    create: (callbacks: PeerManagerHandle) => AbstractPeer,
  ): Promise<void> {
    assertValidPeerName(name);
    const callbacks: PeerManagerHandle = {
      invokeFunction: (funcName, inData) => this.handleInbound(name, funcName, inData),
      describeInterface: () => this.describeInbound(name),
    };
    const connection = create(callbacks);

    const existing = this.peers.get(name);
    if (existing) {
      existing.connection?.close();
      existing.connection = connection;
      Logger.logEvent({ category: "peer", action: "connected", target: name });
      return; // binding unchanged → nothing to persist
    }
    this.peers.set(name, { name, interfaceName: null, connection });
    await this.persist(); // a newly-known peer is a change to the store
    Logger.logEvent({ category: "peer", action: "attached", target: name });
  }

  /**
   * Drop a peer's live connection but keep its record + remembered interface, so
   * a later {@link attachPeer} reapplies the binding. Use when a process exits
   * but may be respawned.
   */
  detachPeer(name: string): void {
    const entry = this.peers.get(name);
    if (!entry?.connection) return;
    entry.connection.close();
    entry.connection = undefined;
    Logger.logEvent({ category: "peer", action: "detached", target: name });
    // The binding is untouched, so there's nothing to persist.
  }

  /** Forget a peer entirely: close its connection and erase its binding. */
  async removePeer(name: string): Promise<void> {
    const entry = this.peers.get(name);
    if (!entry) return;
    entry.connection?.close();
    this.peers.delete(name);
    await this.persist();
    Logger.logEvent({ category: "peer", action: "removed", target: name });
  }

  /**
   * Bind a peer to an interface (or pass null to clear it), persisting the
   * change. The interface need not exist yet — it's resolved at call time — but
   * the peer record must already exist.
   */
  async setPeerInterface(name: string, interfaceName: string | null): Promise<void> {
    const entry = this.requirePeer(name);
    entry.interfaceName = interfaceName;
    await this.persist();
    Logger.logEvent(
      interfaceName
        ? { category: "peer", action: "set interface", target: name, details: { interface: interfaceName } }
        : { category: "peer", action: "cleared interface", target: name },
    );
  }

  /** The interface bound to `name`, or null if none / unknown peer. */
  getPeerInterface(name: string): string | null {
    return this.peers.get(name)?.interfaceName ?? null;
  }

  /**
   * Call a function on a connected peer. Errors as a value (never throws) if the
   * peer is unknown or not currently connected.
   */
  async callPeer(name: string, funcName: string, inData: string): Promise<CallResult> {
    const entry = this.peers.get(name);
    if (!entry) return { ok: false, error: `no peer named "${name}"` };
    if (!entry.connection) return { ok: false, error: `peer "${name}" is not connected` };
    return entry.connection.sendRpc(funcName, inData);
  }

  getPeer(name: string): PeerView | undefined {
    const entry = this.peers.get(name);
    return entry ? toView(entry) : undefined;
  }

  listPeers(): string[] {
    return [...this.peers.keys()];
  }

  isConnected(name: string): boolean {
    return this.peers.get(name)?.connection !== undefined;
  }

  /**
   * Handle an inbound call from `name`: enforce that `funcName` is in the peer's
   * assigned interface, then delegate to the FunctionManager. This is the access
   * gate every incoming call passes through.
   */
  private async handleInbound(
    name: string,
    funcName: string,
    inData: string,
  ): Promise<CallResult> {
    const entry = this.peers.get(name);
    if (!entry) return { ok: false, error: `no peer named "${name}"` };

    const ifaceName = entry.interfaceName;
    if (!ifaceName) {
      return { ok: false, error: `peer "${name}" has no interface assigned` };
    }
    const iface = this.gateway.getInterface(ifaceName);
    if (!iface) {
      return { ok: false, error: `interface "${ifaceName}" no longer exists` };
    }
    if (!iface.funcs.includes(funcName)) {
      return {
        ok: false,
        error: `function "${funcName}" is not in interface "${ifaceName}"`,
      };
    }
    return this.gateway.executeFunc(funcName, inData);
  }

  /**
   * Describe the callable surface currently exposed to `name`, for inbound
   * discovery (e.g. an HTTP client asking "what may I call?"). Reuses the same
   * binding the access gate enforces, so the answer can never advertise more
   * than {@link handleInbound} would permit. A peer with no interface assigned
   * gets an empty (but well-formed) description rather than an error — nothing
   * exposed yet is a valid answer, not a failure.
   */
  private async describeInbound(name: string): Promise<CallResult> {
    const entry = this.peers.get(name);
    if (!entry) return { ok: false, error: `no peer named "${name}"` };

    const ifaceName = entry.interfaceName;
    if (!ifaceName) {
      return { ok: true, value: JSON.stringify({ name: null, funcs: [] }) };
    }
    // Guard existence here (same as handleInbound) so describeInterface, which
    // throws on an unknown interface, is only called once we know it resolves.
    if (!this.gateway.getInterface(ifaceName)) {
      return { ok: false, error: `interface "${ifaceName}" no longer exists` };
    }
    return { ok: true, value: JSON.stringify(this.gateway.describeInterface(ifaceName)) };
  }

  private requirePeer(name: string): PeerEntry {
    const entry = this.peers.get(name);
    if (!entry) throw new Error(`no peer named "${name}"`);
    return entry;
  }

  private async persist(): Promise<void> {
    const store: PeerStore = { peers: {} };
    for (const entry of this.peers.values()) {
      store.peers[entry.name] = { interface: entry.interfaceName };
    }
    await writeFile(this.storePath, JSON.stringify(store, null, 2));
  }

  private async restore(): Promise<void> {
    let store: PeerStore;
    try {
      store = JSON.parse(await readFile(this.storePath, "utf8")) as PeerStore;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return; // fresh goblin
      throw err;
    }
    for (const [name, meta] of Object.entries(store.peers ?? {})) {
      this.peers.set(name, { name, interfaceName: meta.interface ?? null });
    }
  }
}

function toView(entry: PeerEntry): PeerView {
  return {
    name: entry.name,
    interfaceName: entry.interfaceName,
    connected: entry.connection !== undefined,
  };
}

/**
 * Throw unless `name` is a safe, portable peer name. Exported so callers that
 * derive filesystem paths or fork processes from a name (e.g. SpawnManager) can
 * reject it before acting, rather than discovering the problem at attachPeer.
 */
export function assertValidPeerName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(`invalid peer name "${name}": must match ${VALID_NAME}`);
  }
}
