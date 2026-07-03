import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readAgentSocket } from "../socket_server.js";
import { Recorder } from "./recorder.js";

const PORT = 7777;
const SKIP = new Set([".git", "node_modules"]);

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
  let filePath = path.join(STATIC_DIR, urlPath);

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    // File not found — SPA fallback to index.html
    filePath = path.join(STATIC_DIR, "index.html");
  }

  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch {
    res.writeHead(404);
    res.end("Not found — run `npm run build` in inspector/");
    return;
  }

  res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
  res.end(content);
}

async function buildTree(dir: string, rootDir: string): Promise<unknown[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const children = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      children.push({
        name: entry.name,
        path: relPath,
        type: "dir",
        children: await buildTree(fullPath, rootDir),
      });
    } else {
      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        content = "(binary)";
      }
      children.push({ name: entry.name, path: relPath, type: "file", content });
    }
  }
  return children;
}

/**
 * Forward a chat message to the goblin's agent socket, discovered via the
 * `agent-socket.json` file in the root dir. Returns the agent's reply, or a
 * 503 if the socket isn't published / reachable.
 */
async function askAgent(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const info = await readAgentSocket(rootDir);
  if (!info) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "agent socket not running (no agent-socket.json)" }));
    return;
  }

  let message: string;
  try {
    const parsed = JSON.parse(await readBody(req)) as { message?: unknown };
    if (typeof parsed.message !== "string") throw new Error("body must be { message: string }");
    message = parsed.message;
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }

  // The published host may be a wildcard bind (0.0.0.0 / ::) we can't dial;
  // connect over loopback in that case.
  const host = info.host === "0.0.0.0" || info.host === "::" ? "127.0.0.1" : info.host;
  try {
    const upstream = await fetch(`http://${host}:${info.port}/ask-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(await upstream.text());
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `agent unreachable: ${(err as Error).message}` }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Run a recorder action and reply with the resulting status JSON. */
async function handleRecord(
  recorder: Recorder,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  try {
    let status;
    if (pathname === "/record/start") status = await recorder.start();
    else if (pathname === "/record/stop") status = await recorder.stop();
    else status = recorder.status; // /record/status
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } catch (err) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

export function startInspectorServer(rootDir: string): void {
  const recorder = new Recorder(rootDir);

  createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);

    if (url.pathname === "/tree") {
      try {
        const children = await buildTree(rootDir, rootDir);
        const tree = { name: path.basename(rootDir), path: "", type: "dir", children };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(tree));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    } else if (url.pathname === "/ask" && req.method === "POST") {
      await askAgent(rootDir, req, res);
    } else if (url.pathname.startsWith("/record/")) {
      await handleRecord(recorder, url.pathname, res);
    } else {
      await serveStatic(url.pathname, res);
    }
  }).listen(PORT, () => {
    console.log(`Inspector: http://localhost:${PORT}`);
  });
}
