import { createServer, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingEvent, RecordingHeader } from "../shared/events.js";

const PORT = 7780;

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");

const RECORDINGS_SUBDIR = "recordings";
const REC_EXT = ".jsonl";

/**
 * What the server was pointed at. A single recording file (classic mode), or a
 * directory of recordings — either a goblin root dir (whose `recordings/`
 * subdir we find) or a `recordings/` dir itself.
 */
type Source = { kind: "file"; file: string } | { kind: "dir"; dir: string };

/** Metadata for one recording in a directory source. */
interface RecordingInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Classify an input path: a `.jsonl` file stays a file source; a directory
 * becomes a dir source, preferring a nested `recordings/` subdir (so you can
 * pass a goblin root dir) and otherwise treating the directory as the
 * recordings dir itself. Throws (with a clear message) if the path is missing.
 */
async function resolveSource(inputPath: string): Promise<Source> {
  const abs = path.resolve(inputPath);
  const s = await stat(abs).catch(() => {
    throw new Error(`no such file or directory: ${abs}`);
  });
  if (s.isFile()) return { kind: "file", file: abs };

  const nested = path.join(abs, RECORDINGS_SUBDIR);
  if (await stat(nested).then((n) => n.isDirectory()).catch(() => false)) {
    return { kind: "dir", dir: nested };
  }
  return { kind: "dir", dir: abs };
}

/** Every `.jsonl` recording in a directory, newest first. */
async function listRecordings(dir: string): Promise<RecordingInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: RecordingInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(REC_EXT)) continue;
    const s = await stat(path.join(dir, e.name));
    out.push({ name: e.name, size: s.size, mtimeMs: s.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A recording filename is safe iff it's a bare basename ending in `.jsonl`
 *  (no path separators / traversal). Returns it, or null if unsafe. */
function safeRecordingName(name: string): string | null {
  const base = path.basename(name);
  return base === name && base.endsWith(REC_EXT) ? base : null;
}

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** List the recordings a client can choose from, for the in-app picker. */
async function recordingsList(source: Source): Promise<RecordingInfo[]> {
  if (source.kind === "file") {
    const s = await stat(source.file);
    return [{ name: path.basename(source.file), size: s.size, mtimeMs: s.mtimeMs }];
  }
  return listRecordings(source.dir);
}

/**
 * Resolve which recording file a `/recording` request refers to. File sources
 * ignore any `?file=`; dir sources honour it (validated to a safe basename) and
 * otherwise default to the newest recording. Throws on a bad/absent selection.
 */
async function resolveRequestedFile(source: Source, requested: string | null): Promise<string> {
  if (source.kind === "file") return source.file;

  if (requested) {
    const name = safeRecordingName(requested);
    if (!name) throw new Error(`invalid recording name: ${requested}`);
    return path.join(source.dir, name);
  }
  const recs = await listRecordings(source.dir);
  if (!recs.length) throw new Error(`no ${REC_EXT} recordings in ${source.dir}`);
  return path.join(source.dir, recs[0].name);
}

export async function startVisualizerServer(inputPath: string): Promise<void> {
  const source = await resolveSource(inputPath);

  createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);

    if (url.pathname === "/recordings") {
      try {
        sendJson(res, 200, { recordings: await recordingsList(source) });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    } else if (url.pathname === "/recording") {
      try {
        const file = await resolveRequestedFile(source, url.searchParams.get("file"));
        const { header, events } = await loadRecording(file);
        sendJson(res, 200, { file: path.basename(file), header, events });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    } else {
      await serveStatic(url.pathname, res);
    }
  }).listen(PORT, () => {
    const where =
      source.kind === "file"
        ? path.basename(source.file)
        : `${source.dir} (dir)`;
    console.log(`Visualizer: http://localhost:${PORT}  (${where})`);
  });
}
