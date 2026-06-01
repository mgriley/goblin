/**
 * An {@link AbstractPeer} over a Node IPC channel — a forked child process, or
 * `process` itself for talking to our parent. This is the only transport for
 * V1, since the elf hierarchy is a process tree wired together by `fork()`.
 *
 * It owns request/response correlation for a single edge: each outgoing call
 * gets a unique id, the matching reply resolves its promise, and inbound calls
 * are dispatched to `managerHandle.invokeFunction` with the result shipped back. (This
 * supersedes the old standalone `messenger.ts`, which multiplexed every peer
 * through one handler; here each edge is its own self-contained `IpcPeer`.)
 *
 * Wire shapes, discriminated by `__peer` and validated on receipt:
 *   request:  { __peer: "request",  id, funcName, inData }
 *   response: { __peer: "response", id, result }
 */

import type { ChildProcess } from "node:child_process";

import { Schema } from "../utils/schema.js";
import { AbstractPeer, type CallResult, type PeerManagerHandle } from "./peer.js";

/** Either end of a Node IPC channel exposes this slice of the API. */
export type IpcChannel = Pick<ChildProcess, "send" | "on" | "off">;

interface RequestMessage {
  __peer: "request";
  id: string;
  funcName: string;
  inData: string;
}

interface ResponseMessage {
  __peer: "response";
  id: string;
  result: CallResult;
}

// Inbound requests come from another process, so validate their flat string
// fields before use. Responses carry a `CallResult` union (not expressible in
// our mini-schema) and are checked structurally in `isResponse` instead.
const requestSchema = new Schema<RequestMessage>({
  type: "object",
  properties: {
    __peer: { type: "string" },
    id: { type: "string" },
    funcName: { type: "string" },
    inData: { type: "string" },
  },
});

export class IpcPeer extends AbstractPeer {
  private nextId = 0;
  private readonly pending = new Map<string, (result: CallResult) => void>();
  private closed = false;
  private readonly listener: (msg: unknown) => void;

  constructor(
    private readonly channel: IpcChannel,
    callbacks: PeerManagerHandle,
  ) {
    super(callbacks);
    this.listener = (msg) => void this.handleIncoming(msg);
    this.channel.on("message", this.listener);
  }

  async sendRpc(funcName: string, inData: string): Promise<CallResult> {
    if (this.closed) return { ok: false, error: "peer connection is closed" };

    const id = `call-${++this.nextId}`;
    return new Promise<CallResult>((resolve) => {
      this.pending.set(id, resolve);
      const request: RequestMessage = { __peer: "request", id, funcName, inData };
      // `send` returns false (or is absent) when there is no live IPC channel —
      // e.g. the peer process already exited. Degrade to an error result.
      const sent = this.channel.send?.(request);
      if (sent === false || sent === undefined) {
        this.pending.delete(id);
        resolve({ ok: false, error: "peer has no IPC channel" });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.off("message", this.listener);
    for (const resolve of this.pending.values()) {
      resolve({ ok: false, error: "peer connection closed before reply" });
    }
    this.pending.clear();
  }

  private async handleIncoming(msg: unknown): Promise<void> {
    const kind =
      typeof msg === "object" && msg !== null
        ? (msg as Record<string, unknown>).__peer
        : undefined;

    if (kind === "response") {
      if (!isResponse(msg)) return;
      const resolve = this.pending.get(msg.id);
      if (!resolve) return; // unknown/duplicate id — ignore
      this.pending.delete(msg.id);
      resolve(msg.result);
      return;
    }

    if (kind !== "request") return;
    const parsed = requestSchema.safeParse(msg);
    if (!parsed.ok) return;
    const { id, funcName, inData } = parsed.value;

    const result = await this.managerHandle.invokeFunction(funcName, inData);
    const reply: ResponseMessage = { __peer: "response", id, result };
    this.channel.send?.(reply);
  }
}

/** Structural guard for a response envelope (its `result` is a union type). */
function isResponse(msg: unknown): msg is ResponseMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.__peer !== "response" || typeof m.id !== "string") return false;
  const r = m.result;
  if (typeof r !== "object" || r === null) return false;
  const res = r as Record<string, unknown>;
  if (res.ok === true) return typeof res.value === "string";
  if (res.ok === false) return typeof res.error === "string";
  return false;
}
