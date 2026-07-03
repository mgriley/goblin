/**
 * Recorder — captures a replayable "recording" of the whole goblin network.
 *
 * On {@link start} it walks the tree (root + `children/**`), captures a baseline
 * state snapshot of every live goblin, and writes it as the recording's header.
 * Then a poll loop tails each goblin's `event_log.jsonl` by `seq`, stamps the
 * originating `goblinId` (the dir path relative to root), and appends each new
 * event to `recordings/<timestamp>.jsonl`. {@link stop} drains once more and
 * finalizes the file.
 *
 * The recording is self-contained: header baseline + the event stream is enough
 * for the visualizer to reconstruct full per-goblin state at any point, with no
 * file reads of its own.
 *
 * Recording file shape (one JSON object per line):
 *   line 0:  { type: "header", startedAt, root, goblins: [{ id, state }] }
 *   line 1+: { type: "event", goblinId, ts, seq, category, action, target?, details? }
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GoblinState } from "../shared/events.js";

const POLL_MS = 1000;
const EVENT_LOG = "event_log.jsonl";

/** A structured event as stored per-goblin (see Logger). */
interface RecordedEvent {
  ts: string;
  seq: number;
  category: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

export interface RecorderStatus {
  recording: boolean;
  startedAt: string | null;
  events: number;
  file: string | null;
}

export class Recorder {
  private filePath: string | null = null;
  private startedAt: string | null = null;
  private events = 0;
  // goblinId -> last seq already written to the recording.
  private readonly cursors = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // Serialises drains so a poll tick and stop() never overlap.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  get status(): RecorderStatus {
    return {
      recording: this.filePath !== null,
      startedAt: this.startedAt,
      events: this.events,
      file: this.filePath,
    };
  }

  /** Begin a recording: snapshot the baseline, then start tailing. Idempotent-ish:
   *  throws if one is already in progress. */
  async start(): Promise<RecorderStatus> {
    if (this.filePath) throw new Error("already recording");

    this.startedAt = new Date().toISOString();
    this.events = 0;
    this.cursors.clear();

    const recordingsDir = path.join(this.rootDir, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    this.filePath = path.join(recordingsDir, `${this.startedAt.replace(/[:.]/g, "-")}.jsonl`);

    // Baseline: snapshot every live goblin and set its cursor to the current end
    // of its log, so only events from *now on* are captured on top of the snapshot.
    const goblins = await discoverGoblins(this.rootDir);
    const baseline: { id: string; state: GoblinState }[] = [];
    for (const g of goblins) {
      baseline.push({ id: g.id, state: await snapshotGoblin(g.dir) });
      this.cursors.set(g.id, await lastSeq(g.dir));
    }
    const header = {
      type: "header",
      startedAt: this.startedAt,
      root: path.basename(this.rootDir),
      goblins: baseline,
    };
    await writeFile(this.filePath, JSON.stringify(header) + "\n");

    this.timer = setInterval(() => void this.schedule(), POLL_MS);
    return this.status;
  }

  /** Stop recording, draining any pending events first. */
  async stop(): Promise<RecorderStatus> {
    if (!this.filePath) return this.status;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.schedule(); // final drain
    const finalStatus: RecorderStatus = { ...this.status, recording: false };
    this.filePath = null;
    this.startedAt = null;
    return finalStatus;
  }

  /** Chain one drain onto the queue so ticks never overlap. */
  private schedule(): Promise<void> {
    this.queue = this.queue.then(() => this.drain()).catch(() => {});
    return this.queue;
  }

  /** Tail every goblin once and append new events to the recording. */
  private async drain(): Promise<void> {
    if (!this.filePath) return;
    const goblins = await discoverGoblins(this.rootDir);
    const lines: string[] = [];
    for (const g of goblins) {
      // A goblin discovered after start() was born during recording — it had no
      // pre-record state, so capture it from seq 0.
      if (!this.cursors.has(g.id)) this.cursors.set(g.id, 0);
      const cursor = this.cursors.get(g.id)!;
      const newEvents = await readEventsAfter(g.dir, cursor);
      for (const e of newEvents) {
        lines.push(JSON.stringify({ type: "event", goblinId: g.id, ...e }));
        this.cursors.set(g.id, e.seq);
        this.events++;
      }
    }
    if (lines.length > 0) await appendFile(this.filePath, lines.join("\n") + "\n");
  }
}

// ---------------------------------------------------------------------------
// Discovery + tailing
// ---------------------------------------------------------------------------

/** Every goblin dir under root, identified by its path relative to root
 *  (`""` = root, `children/foo`, `children/foo/children/bar`, …). */
async function discoverGoblins(rootDir: string): Promise<{ id: string; dir: string }[]> {
  const out: { id: string; dir: string }[] = [];
  async function walk(dir: string): Promise<void> {
    out.push({ id: path.relative(rootDir, dir), dir });
    let entries;
    try {
      entries = await readdir(path.join(dir, "children"), { withFileTypes: true });
    } catch {
      return; // no children dir → leaf goblin
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, "children", e.name));
    }
  }
  await walk(rootDir);
  return out;
}

/** The highest seq currently in a goblin's event log, or 0 if none. */
async function lastSeq(dir: string): Promise<number> {
  const events = await readEventsAfter(dir, -Infinity);
  return events.length ? events[events.length - 1].seq : 0;
}

/** Parse a goblin's event log and return events with `seq > after`, in order. */
async function readEventsAfter(dir: string, after: number): Promise<RecordedEvent[]> {
  let content: string;
  try {
    content = await readFile(path.join(dir, EVENT_LOG), "utf8");
  } catch {
    return [];
  }
  const events: RecordedEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as RecordedEvent;
      if (typeof e.seq === "number" && e.seq > after) events.push(e);
    } catch {
      // Partial trailing line mid-write, or a corrupt line — skip; the cursor
      // doesn't advance past it, so a complete version is picked up next poll.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Baseline snapshot — reads each manager's on-disk format
// ---------------------------------------------------------------------------

async function snapshotGoblin(dir: string): Promise<GoblinState> {
  return {
    notes: await readNotes(dir),
    db: await readDb(dir),
    ...(await readFunctions(dir)),
    peers: await readPeers(dir),
    ports: await readPorts(dir),
  };
}

/** notes/<name>.md → { name: content }. */
async function readNotes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of await listDir(path.join(dir, "notes"))) {
    if (!file.endsWith(".md")) continue;
    out[file.slice(0, -3)] = await readText(path.join(dir, "notes", file));
  }
  return out;
}

/** database/<key with / → #> → { key: value }. */
async function readDb(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of await listDir(path.join(dir, "database"))) {
    if (file.endsWith(".tmp")) continue; // in-flight atomic write
    out[file.replaceAll("#", "/")] = await readText(path.join(dir, "database", file));
  }
  return out;
}

interface FunctionsStore {
  funcs?: Record<string, { sharedLibs?: string[] }>;
  libs?: string[];
  interfaces?: Record<string, { funcs?: string[] }>;
}

/** functions.json + funcs/<name>.mjs + libs/<name>.mjs → funcs/libs/interfaces. */
async function readFunctions(
  dir: string,
): Promise<Pick<GoblinState, "funcs" | "libs" | "interfaces">> {
  const store = await readJson<FunctionsStore>(path.join(dir, "functions.json"), {});
  const funcs: GoblinState["funcs"] = {};
  for (const [name, meta] of Object.entries(store.funcs ?? {})) {
    funcs[name] = {
      code: await readText(path.join(dir, "funcs", `${name}.mjs`)),
      sharedLibs: meta.sharedLibs ?? [],
    };
  }
  const libs: GoblinState["libs"] = {};
  for (const name of store.libs ?? []) {
    libs[name] = await readText(path.join(dir, "libs", `${name}.mjs`));
  }
  const interfaces: GoblinState["interfaces"] = {};
  for (const [name, iface] of Object.entries(store.interfaces ?? {})) {
    interfaces[name] = iface.funcs ?? [];
  }
  return { funcs, libs, interfaces };
}

/** peers.json → { name: interfaceName | null }. */
async function readPeers(dir: string): Promise<Record<string, string | null>> {
  const store = await readJson<{ peers?: Record<string, { interface?: string | null }> }>(
    path.join(dir, "peers.json"),
    {},
  );
  const out: Record<string, string | null> = {};
  for (const [name, p] of Object.entries(store.peers ?? {})) out[name] = p.interface ?? null;
  return out;
}

/** ports.json → { name: { host, port } }. */
async function readPorts(dir: string): Promise<Record<string, { host: string; port: number }>> {
  const store = await readJson<{ ports?: Record<string, { host: string; port: number }> }>(
    path.join(dir, "ports.json"),
    {},
  );
  return store.ports ?? {};
}

// ---------------------------------------------------------------------------
// Small fs helpers (all tolerate a missing path)
// ---------------------------------------------------------------------------

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
