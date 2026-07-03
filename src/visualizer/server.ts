import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 7780;

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

/** The header written as line 0 of a recording (see Recorder). */
interface RecordingHeader {
  type: "header";
  startedAt: string;
  root: string;
  goblins: { id: string; state: unknown }[];
}

/** An event line (line 1+) of a recording. */
interface RecordingEvent {
  type: "event";
  goblinId: string;
  ts: string;
  seq: number;
  category: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

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
    res.end("Not found — run `npm run build`");
    return;
  }

  res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
  res.end(content);
}

/**
 * Parse a recording file into its header + ordered events. Re-read on every
 * request so a still-growing recording is reflected live. Tolerates partial
 * trailing lines and corrupt lines (skipped).
 */
async function loadRecording(
  file: string,
): Promise<{ header: RecordingHeader | null; events: RecordingEvent[] }> {
  const content = await readFile(file, "utf8");
  let header: RecordingHeader | null = null;
  const events: RecordingEvent[] = [];

  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: RecordingHeader | RecordingEvent;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // partial trailing write or corrupt line
    }
    if (obj.type === "header") header = obj;
    else if (obj.type === "event") events.push(obj);
  }
  return { header, events };
}

export function startVisualizerServer(recordingFile: string): void {
  const absFile = path.resolve(recordingFile);

  createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);

    if (url.pathname === "/recording") {
      try {
        const { header, events } = await loadRecording(absFile);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ file: path.basename(absFile), header, events }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    } else {
      await serveStatic(url.pathname, res);
    }
  }).listen(PORT, () => {
    console.log(`Visualizer: http://localhost:${PORT}  (${path.basename(absFile)})`);
  });
}
