/**
 * SpawnManager — spawns child goblins as child processes and registers them
 * as peers with the PeerManager.
 *
 * In V1 the only peers are processes in our own tree: we talk to children we
 * spawn (and, separately, to the parent that spawned us). SpawnManager owns the
 * *existence* side of that — spawning a child, tracking its process, restarting
 * the set on startup, tearing one down — and hands each live child to
 * {@link PeerManager} as an {@link IpcPeer}. It deliberately knows nothing about
 * interfaces; the binding (and its persistence) lives in PeerManager.
 *
 * A child's durable identity is its workspace directory under `childrenDir`
 * (holding a "Purpose" note). That directory — not any in-memory list — is the
 * source of truth for "which children should exist", so {@link spawnAllExisting}
 * can rebuild the whole set after a restart by reading the disk.
 */

import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { findAllSubdirs } from "../utils/utils.js";
import { Logger } from "../utils/logger.js";
import { resolveScript } from "../utils/spawn.js";
import { IpcPeer } from "./ipc_peer.js";
import { assertValidPeerName, type PeerManager } from "../peers/peer_manager.js";

export interface SpawnManagerOptions {
  /** Directory holding one subdir per child goblin (its workspace). */
  childrenDir: string;
  /** `import.meta.url` of the calling module; used to resolve the child entry point. */
  importMetaUrl: string;
  /** PeerManager to register each spawned child's connection with. */
  peerManager: PeerManager;
  /**
   * Build the IPC init message handed to a freshly spawned child. Receives the
   * child's workspace dir and its purpose (undefined when respawning an existing
   * child whose Purpose note already exists). Node buffers it until the child's
   * event loop starts.
   */
  initPayload: (childDir: string, purpose?: string) => Serializable;
}

export class SpawnManager {
  private readonly children = new Map<string, ChildProcess>();
  private readonly childrenDir: string;
  private readonly script: string;
  private readonly execArgv: string[];
  private readonly peerManager: PeerManager;
  private readonly initPayload: (childDir: string, purpose?: string) => Serializable;

  constructor(opts: SpawnManagerOptions) {
    this.childrenDir = opts.childrenDir;
    ({ script: this.script, execArgv: this.execArgv } = resolveScript(opts.importMetaUrl, "main"));
    this.peerManager = opts.peerManager;
    this.initPayload = opts.initPayload;
  }

  /**
   * Create a new child goblin: ensure its workspace dir (with a "Purpose" note)
   * exists, then fork and connect it. The child's name is its directory name
   * and its peer name. Throws if a child with this name is already running.
   */
  async spawnActor(name: string, purpose: string): Promise<void> {
    // Reject bad names before they reach the filesystem: `name` becomes a
    // directory under childrenDir, so an invalid one risks path traversal. Uses
    // PeerManager's rule (where it's re-checked at attachPeer) to avoid drift.
    assertValidPeerName(name);
    if (this.children.has(name)) {
      throw new Error(`spawnActor: child "${name}" is already running`);
    }
    const childDir = path.join(this.childrenDir, name);
    await this.ensureWorkDir(childDir);
    await this.launch(name, childDir, purpose);
    Logger.logEvent({ category: "spawn", action: "spawned", target: name, details: { purpose } });
  }

  /**
   * Bring up every child whose workspace dir already exists on disk. Called on
   * startup to resume where we left off; skips any that are already running.
   */
  async spawnAllExisting(): Promise<void> {
    for (const childDir of await findAllSubdirs(this.childrenDir)) {
      const name = path.basename(childDir);
      if (this.children.has(name)) continue;
      await this.launch(name, childDir);
    }
  }

  /**
   * Terminate a child and forget it entirely: SIGTERM the process, drop it from
   * PeerManager, and delete its workspace dir so it won't be respawned. Safe to
   * call on an unknown name (no-op).
   */
  async removeActor(name: string): Promise<void> {
    await this.terminate(name);
    await this.peerManager.removePeer(name);
    await rm(path.join(this.childrenDir, name), { recursive: true, force: true });
    Logger.logEvent({ category: "spawn", action: "removed", target: name });
  }

  /** SIGTERM a running child and wait for it to exit. No-op if not running. */
  async terminate(name: string): Promise<void> {
    const proc = this.children.get(name);
    if (!proc) return;
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill();
      });
    }
    this.children.delete(name);
  }

  /** Names of children currently running under this manager. */
  listRunning(): string[] {
    return [...this.children.keys()];
  }

  /** Fork a child for `childDir`, register it as a peer, and track its process. */
  private async launch(name: string, childDir: string, purpose?: string): Promise<void> {
    const proc = fork(this.script, [], { execArgv: this.execArgv });
    proc.send(this.initPayload(childDir, purpose));
    this.children.set(name, proc);

    // The child IPC channel becomes this peer's transport. Routing the factory
    // through PeerManager binds inbound calls to access control for `name`.
    await this.peerManager.attachPeer(name, (callbacks) => new IpcPeer(proc, callbacks));

    proc.on("exit", (code, signal) => {
      // Only forget the process + connection; keep the peer record so a respawn
      // reapplies its interface. The workspace dir survives, so the child is
      // still "existing" for spawnAllExisting on the next startup.
      if (this.children.get(name) === proc) this.children.delete(name);
      this.peerManager.detachPeer(name);
      const reason = signal ?? (code !== null ? `code ${code}` : "unknown");
      Logger.logEvent({ category: "spawn", action: "exited", target: name, details: { reason } });
    });
    proc.on("error", (err) => {
      console.error(`[spawn] child "${name}" error:`, err);
    });
  }

  /** Ensure `childDir` exists. No-op if already present. */
  private async ensureWorkDir(childDir: string): Promise<void> {
    await mkdir(childDir, { recursive: true });
  }
}
