/**
 * An {@link AbstractPeer} over Node's built-in `http.Server` (zero deps) — the
 * edge that lets an elf act like a server. It is the HTTP counterpart to
 * {@link import("./ipc_peer.js").IpcPeer}: where IpcPeer wraps a duplex IPC
 * channel to one process, HttpPeer wraps a listening socket whose many anonymous
 * clients all share this single peer identity ("the public edge for port N").
 *
 * It is *inbound-only*. There is no single counterparty to push to, so
 * {@link sendRpc} always fails as a value — an HttpPeer never initiates calls. Its
 * whole job is the inbound direction, translating an HTTP request into the exact
 * same call an IPC request makes:
 *
 *   HTTP request -> (funcName, inData) -> managerHandle.invokeFunction -> CallResult -> HTTP response
 *
 * So the peer's assigned interface is its public API surface, and access control
 * is reused verbatim — HttpPeer adds no new execution path or auth model.
 *
 * Wire mapping (V1, deliberately minimal):
 *   POST /<funcName>   body = inData (JSON text)
 *     { ok: true }  -> 200 + output JSON text
 *     { ok: false } -> 4xx/5xx + error string   (see {@link statusForError})
 *   GET  /             -> 200 health check ("ok")
 *   anything else      -> 405 / 404
 *
 * Because HTTP is natively request/response, there is no id-correlation tracker
 * (unlike IpcPeer, which multiplexes many calls over one channel): each request
 * is self-contained and handled concurrently.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { AbstractPeer, type CallResult, type PeerManagerHandle } from "./peer.js";

/** Cap on request body size, so a single client can't exhaust memory. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class HttpPeer extends AbstractPeer {
  private closed = false;
  private readonly onRequest: (req: IncomingMessage, res: ServerResponse) => void;

  /**
   * Wraps an already-created `http.Server` and attaches its request handler. The
   * server is *not* listening yet — {@link import("./ports_manager.js").PortsManager}
   * owns calling `listen()` after attach, mirroring how SpawnManager `fork()`s the
   * process it then hands to IpcPeer.
   */
  constructor(
    private readonly server: Server,
    managerHandle: PeerManagerHandle,
  ) {
    super(managerHandle);
    this.onRequest = (req, res) => void this.handleRequest(req, res);
    this.server.on("request", this.onRequest);
  }

  /** An HttpPeer is inbound-only; it has no single client to call out to. */
  async sendRpc(): Promise<CallResult> {
    return { ok: false, error: "http peer is inbound-only; cannot initiate RPC" };
  }

  /** Stop listening and detach the handler. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.off("request", this.onRequest);
    // `close()` stops accepting new connections; we don't track keep-alive
    // sockets, so in-flight requests are allowed to finish naturally.
    this.server.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    // `req.url` is a path+query like "/ping?x=1"; we only key off the path.
    const path = decodeURIComponent((req.url ?? "/").split("?", 1)[0]);

    // Health check / liveness probe.
    if (method === "GET" && path === "/") {
      return respond(res, 200, "ok");
    }
    if (method !== "POST") {
      return respond(res, 405, `method ${method} not allowed; use POST /<funcName>`);
    }

    const funcName = path.replace(/^\/+/, "");
    if (!funcName) {
      return respond(res, 404, "missing function name; use POST /<funcName>");
    }

    let inData: string;
    try {
      inData = await readBody(req);
    } catch (err) {
      return respond(res, 413, err instanceof Error ? err.message : String(err));
    }

    const result = await this.managerHandle.invokeFunction(funcName, inData);
    if (result.ok) {
      return respond(res, 200, result.value, "application/json");
    }
    return respond(res, statusForError(result.error), result.error);
  }
}

/** Read the full request body as a UTF-8 string, rejecting if it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Map a CallResult error string onto an HTTP status. The error is only a
 * human-readable string (Result carries no code), so this matches on the phrases
 * PeerManager/FunctionManager produce. Anything unrecognized is treated as a
 * server-side failure (500) rather than a client error.
 */
function statusForError(error: string): number {
  if (/has no interface assigned/.test(error)) return 403; // peer reachable, nothing exposed
  if (/no function named|not in interface|no longer exists|no peer named/.test(error)) {
    return 404; // function isn't part of this port's surface
  }
  if (/not valid JSON|input validation failed/.test(error)) return 400; // bad request
  return 500; // runtime error, output validation, etc.
}

function respond(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}
