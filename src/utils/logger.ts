import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TXT_FILE = "event_log.txt";
const JSONL_FILE = "event_log.jsonl";
const MAX_BYTES = 512 * 1024; // 512 KB, applied to each file
const MAX_PAYLOAD_BYTES = 4 * 1024; // cap on any single embedded payload string

/**
 * A structured event. Call sites describe *what happened* — category, action,
 * an optional subject (`target`), and an optional self-contained payload
 * (`details`, e.g. a note's new content or a function's new code). The human
 * `event_log.txt` line is derived from this; the full structured form (with
 * payloads) goes to `event_log.jsonl`.
 */
export interface LogEvent {
  /** Subsystem: "goblin" | "database" | "notes" | "func" | "peer" | "port" | "spawn". */
  category: string;
  /** What happened, e.g. "created", "modified", "exited". */
  action: string;
  /** The subject — a name/key, when there is one. */
  target?: string;
  /**
   * Self-contained payload for replay (note content, func code, exit reason, …).
   * Oversized string fields are truncated to {@link MAX_PAYLOAD_BYTES} and the
   * object is flagged `truncated: true`. Never appears in the human log.
   */
  details?: Record<string, unknown>;
}

/** A {@link LogEvent} as persisted to `event_log.jsonl`, stamped with `ts`/`seq`. */
interface RecordedEvent extends LogEvent {
  ts: string;
  seq: number;
}

/**
 * A simple logger that goblins use to record events to files in their work dir,
 * inspectable in the inspector UI. It writes two views of the same stream:
 *
 *   - `event_log.txt`   — human-readable, one `[category] action "target"` line
 *                         per event, never carrying payloads (stays small).
 *   - `event_log.jsonl` — structured, one JSON object per line with `ts`, a
 *                         per-goblin monotonic `seq`, and self-contained
 *                         payloads. This is what the recorder/visualizer consume.
 */
export class Logger {
  private static instance: Logger | null = null;

  private readonly txtPath: string;
  private readonly jsonlPath: string;
  // Per-goblin monotonic event counter, seeded from any existing jsonl on init
  // so it stays monotonic across restarts.
  private seq = 0;
  // Serialise all work: seeding runs first, then each logEvent chains on.
  private queue: Promise<void>;

  private constructor(goblinDir: string) {
    this.txtPath = path.join(goblinDir, TXT_FILE);
    this.jsonlPath = path.join(goblinDir, JSONL_FILE);
    this.queue = this.seedSeq();
  }

  static init(goblinDir: string): void {
    Logger.instance = new Logger(goblinDir);
  }

  static get(): Logger {
    if (!Logger.instance) throw new Error("Logger not initialised — call Logger.init first");
    return Logger.instance;
  }

  /** Record a structured event. Fire-and-forget; errors are swallowed. */
  static logEvent(event: LogEvent): void {
    Logger.instance?.logEventInstance(event);
  }

  private logEventInstance(event: LogEvent): void {
    this.queue = this.queue.then(() => this.write(event)).catch(() => {});
  }

  /** Resume the seq counter from the last line of an existing jsonl, if any. */
  private async seedSeq(): Promise<void> {
    try {
      const content = await readFile(this.jsonlPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const parsed = JSON.parse(last) as { seq?: number };
        if (typeof parsed.seq === "number") this.seq = parsed.seq;
      }
    } catch {
      // No file yet, or an unparseable tail — start from 0.
    }
  }

  private async write(event: LogEvent): Promise<void> {
    const ts = new Date().toISOString();
    const seq = ++this.seq;

    await appendFile(this.txtPath, `${ts}  ${humanLine(event)}\n`);

    const record: RecordedEvent = {
      ts,
      seq,
      category: event.category,
      action: event.action,
      ...(event.target !== undefined ? { target: event.target } : {}),
      ...(event.details ? { details: capPayload(event.details) } : {}),
    };
    await appendFile(this.jsonlPath, JSON.stringify(record) + "\n");

    await this.trimIfNeeded(this.txtPath);
    await this.trimIfNeeded(this.jsonlPath);
  }

  /**
   * Keep a file from growing without bound: once it exceeds MAX_BYTES, drop the
   * oldest half. Both files are line-oriented (the jsonl has one JSON object per
   * line), so slicing on line boundaries keeps each remaining line intact.
   */
  private async trimIfNeeded(filePath: string): Promise<void> {
    const s = await stat(filePath).catch(() => null);
    if (!s || s.size <= MAX_BYTES) return;

    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2));
    await writeFile(filePath, kept.join("\n") + "\n");
  }
}

/** Derive the human log line: `[category] action "target"`. No payloads. */
function humanLine(e: LogEvent): string {
  return `[${e.category}] ${e.action}${e.target !== undefined ? ` "${e.target}"` : ""}`;
}

/**
 * Cap oversized string fields in a payload to {@link MAX_PAYLOAD_BYTES}, flagging
 * the object `truncated: true` if anything was shortened. Returns a shallow copy.
 */
function capPayload(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string" && Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) {
      out[key] = value.slice(0, MAX_PAYLOAD_BYTES);
      truncated = true;
    } else {
      out[key] = value;
    }
  }
  if (truncated) out.truncated = true;
  return out;
}
