import type { ChildProcess } from "node:child_process";
import process from "node:process";

import { Schema } from "./schema.js";

type IPCSender = ChildProcess | NodeJS.Process;

/**
 * Describes who a message came from.
 * - `type: "parentMessage"` — from this process's parent.
 * - `type: "childMessage"`  — from one of our children; `childName` is set.
 */
export interface MessageSource {
  type: "parentMessage" | "childMessage";
  childName?: string;
}

/** Async handler invoked when a peer sends us a request. Returns the reply. */
export type MessageHandler = (
  source: MessageSource,
  message: string,
) => Promise<string>;

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

interface RequestMessage {
  __messenger: "request";
  id: string;
  message: string;
}

interface ResponseMessage {
  __messenger: "response";
  id: string;
  response: string;
}

type WireMessage = RequestMessage | ResponseMessage;

// The two wire shapes are discriminated by `__messenger`: we read that field
// off the raw message, then validate against the matching schema.
const requestSchema = new Schema<RequestMessage>({
  type: "object",
  properties: {
    __messenger: { type: "string" },
    id: { type: "string" },
    message: { type: "string" },
  },
});

const responseSchema = new Schema<ResponseMessage>({
  type: "object",
  properties: {
    __messenger: { type: "string" },
    id: { type: "string" },
    response: { type: "string" },
  },
});

/**
 * Correlates outgoing IPC messages with incoming responses, and dispatches
 * incoming requests to a user-supplied `MessageHandler`.
 *
 * Wire format (validated via `./schema.js`):
 * - request:  `{ __messenger: "request",  id, message }`
 * - response: `{ __messenger: "response", id, response }`
 *
 * Constructor auto-subscribes to `process` so messages from our parent are
 * handled automatically when we're forked. For children we spawn, call
 * `attachChild(name, child)` once per child — Node has no aggregate
 * "any-child-sent-something" event on the parent side.
 */
export class Messenger {
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handler: MessageHandler;

  constructor(handler: MessageHandler) {
    this.handler = handler;
    if (process.send) {
      process.on("message", (msg) =>
        this.handleIncoming(msg, process, { type: "parentMessage" }),
      );
    }
  }

  /** Route messages from `child` (identified by `name`) through this Messenger. */
  attachChild(name: string, child: ChildProcess): void {
    child.on("message", (msg) =>
      this.handleIncoming(msg, child, { type: "childMessage", childName: name }),
    );
  }

  /**
   * Send `message` to `proc` and resolve with the peer's response.
   * Rejects if `proc` has no usable IPC channel.
   */
  async sendMessage(proc: IPCSender, message: string): Promise<string> {
    const id = `msg-${++this.nextId}`;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: RequestMessage = { __messenger: "request", id, message };
      const sent = proc.send?.(request);
      if (sent === false || sent === undefined) {
        this.pending.delete(id);
        reject(new Error("Messenger: target has no IPC channel."));
      }
    });
  }

  private async handleIncoming(
    msg: unknown,
    peer: IPCSender,
    source: MessageSource,
  ): Promise<void> {
    const kind =
      typeof msg === "object" && msg !== null
        ? (msg as Record<string, unknown>).__messenger
        : undefined;

    if (kind === "response") {
      const parsed = responseSchema.safeParse(msg);
      if (!parsed.ok) return;
      const wire = parsed.value;
      const pending = this.pending.get(wire.id);
      if (!pending) return;
      this.pending.delete(wire.id);
      pending.resolve(wire.response);
      return;
    }

    if (kind !== "request") return;
    const parsed = requestSchema.safeParse(msg);
    if (!parsed.ok) return;
    const wire = parsed.value;

    const response = await this.handler(source, wire.message);
    const reply: ResponseMessage = {
      __messenger: "response",
      id: wire.id,
      response,
    };
    peer.send?.(reply);
  }
}
