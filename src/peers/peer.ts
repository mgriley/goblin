/**
 * The peer abstraction — one edge in/out of this elf.
 *
 * A "peer" is whatever this elf can talk to: its parent, a child it spawned,
 * (later) a chat-channel sibling. The transport behind that edge (IPC over a
 * forked process, a socket, an in-process loopback for tests) is the concern of
 * a concrete {@link AbstractPeer} subclass. Everything above — the registry, the
 * interface binding, access control — only ever sees this abstract surface, so
 * adding a new kind of peer never touches {@link import("./peer_manager.js")}.
 *
 * Each Elf communicates with its peers through rpc interfaces. A peer can only
 * call functions on us through the interface we assign it, and we can only 
 * call functions on a peer through the interface it assigns to us. Each function/rpc
 * is a JSON-in, JSON-out operation (the peer sends us JSON text, we parse it and
 * pass it to the function, then stringify the function's output and send it back). Each
 * function has an input schema and output schema to validate the inputs/outputs.
 *
 * The calls use {@link CallResult} so a failure (peer down, unknown func, access denied,
 * runtime error) is reported as a value rather than thrown — a dropped edge
 * never takes down the caller.
 */

import type { Result } from "../utils/utils.js";

/** Outcome of a function call: JSON output text on success, error string otherwise. */
export type CallResult = Result<string>;

/**
 * Each peer gets this handle to the PeerManager so that it can notify the manager
 * when it has received a call from the other side that needs processing. The manager
 * handles actually invoking the right function, checking access, etc.
 */
export interface PeerManagerHandle {
  /** The peer is calling `funcName` on us with `inData` (JSON text). */
  invokeFunction(funcName: string, inData: string): Promise<CallResult>;
}

/**
 * One edge out of this elf. A subclass knows how to ship a call to the other
 * side ({@link sendRpc}) and, when the other side calls us, routes it through
 * `managerHandle.invokeFunction`.
 */
export abstract class AbstractPeer {
  constructor(protected readonly managerHandle: PeerManagerHandle) {}

  /** Send a function call to the peer and resolve with its response. */
  abstract sendRpc(funcName: string, inData: string): Promise<CallResult>;

  /** Tear down the transport and fail any in-flight calls. Idempotent. */
  abstract close(): void;
}
