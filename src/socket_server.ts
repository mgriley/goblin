/**
 * HTTP server for sending messages to the goblin's agent.
 *
 * Bind to 127.0.0.1 (the default) for local-only access, or 0.0.0.0 to
 * expose through Docker's port mapping.
 *
 *   POST /ask-agent   { "message": string }  →  { "response": string }
 *
 * On startup the bound address is written to `agent-socket.json` in the
 * goblin's root dir, so another process can discover where to connect given
 * only the root dir (see {@link readAgentSocket}). The file is best-effort
 * removed on exit; readers should treat it as a hint and tolerate a refused
 * connection or a stale `pid` (a process that no longer exists).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** Name of the discovery file written into the goblin's root dir. */
export const AGENT_SOCKET_FILE = "agent-socket.json";

/** Connection details published to {@link AGENT_SOCKET_FILE}. */
export interface AgentSocketInfo {
  /** PID of the goblin process; lets readers check liveness (e.g. kill(pid, 0)). */
  pid: number;
  port: number;
  host: string;
}

export async function runSocketServer(
  handler: (message: string) => Promise<string>,
  rootDir: string,
  port: number,
  host = "127.0.0.1",
): Promise<number> {
  const server = createServer((req, res) => void handleRequest(req, res, handler));
  await listen(server, port, host);
  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  await publishSocketInfo(rootDir, { pid: process.pid, port: boundPort, host });
  console.log(`Agent socket listening on ${host}:${boundPort}`);
  return boundPort;
}

/**
 * Read the agent socket discovery file from `rootDir`, or undefined if it is
 * absent. The info is a hint: the process may have died since it was written,
 * so callers should still handle a refused connection (and may verify `pid`).
 */
export async function readAgentSocket(rootDir: string): Promise<AgentSocketInfo | undefined> {
  try {
    const raw = await readFile(path.join(rootDir, AGENT_SOCKET_FILE), "utf8");
    return JSON.parse(raw) as AgentSocketInfo;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write the discovery file and best-effort remove it when the process exits. */
async function publishSocketInfo(rootDir: string, info: AgentSocketInfo): Promise<void> {
  const filePath = path.join(rootDir, AGENT_SOCKET_FILE);
  await writeFile(filePath, JSON.stringify(info, null, 2));
  process.on("exit", () => {
    try {
      unlinkSync(filePath);
    } catch {
      // Already gone, or never written — nothing to clean up.
    }
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (message: string) => Promise<string>,
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/ask-agent") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end(err instanceof Error ? err.message : String(err));
    return;
  }

  let message: string;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { message?: unknown }).message !== "string") {
      throw new Error("body must be { message: string }");
    }
    message = (parsed as { message: string }).message;
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(err instanceof Error ? err.message : String(err));
    return;
  }

  const response = await handler(message);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ response }));
}

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

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
