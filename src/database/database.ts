/**
 * Database — an elf's private key/value store for whatever data it needs to
 * keep (customer accounts, app state, …).
 *
 * The interface is a deliberately plain hierarchical KV store: keys are
 * arbitrary strings (the agent tends to organize them like paths, e.g.
 * `customers/123/name`), values are strings. Four operations:
 *   - setValue(key, value)        upsert
 *   - getValue(key)               -> Result<string>
 *   - deleteValue(key)            idempotent
 *   - listKeysWithPrefix(prefix)  -> Result<string[]>
 *
 * Unlike the other managers, this one does NOT cache in memory: customer data
 * can be large and unbounded, so disk is the source of truth and every read and
 * write hits the underlying files directly.
 *
 * On-disk layout: a single flat directory, one file per entry, whose filename is
 * the key percent-encoded (so `/` and other separators can't create nested dirs
 * or escape the root, and the mapping is losslessly reversible for listing):
 *   database/<percent-encoded-key>
 *
 * Writes are atomic — value is written to a temp file and `rename`d into place —
 * so a crash mid-write can never leave a half-written value. Reads return a
 * {@link Result} rather than throwing, since the self-healing agent is expected
 * to cope with a missing or unreadable value as a normal outcome.
 *
 * Schemas are intentionally omitted in V1 (see DesignDocs/Components.md): the
 * store is untyped and the agent adapts to whatever it reads back.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { Result } from "../utils/utils.js";

// Temp files for atomic writes live alongside their target with this suffix.
// Encoded keys never contain a literal "." (see encodeKey), so this suffix can
// never collide with a real entry and lets listing skip in-flight writes.
const TMP_SUFFIX = ".tmp";

export class Database {
  private readonly dataDir: string;
  // Disambiguates concurrent temp files from this process; combined with the
  // pid it keeps two in-flight writes (even to the same key) from clobbering
  // each other's temp file before the rename.
  private writeSeq = 0;
  private started = false;

  constructor(rootDir: string) {
    this.dataDir = path.join(rootDir, "database");
  }

  /** Ensure the data directory exists. Call once before any other method. */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.dataDir, { recursive: true });
    this.started = true;
  }

  /**
   * Set (create or overwrite) the value at `key`. Written atomically: the value
   * goes to a temp file that is then `rename`d over the target, so a reader
   * never sees a partial write. Throws on an empty key or an underlying fs
   * error.
   */
  async setValue(key: string, value: string): Promise<void> {
    const file = this.keyToPath(key);
    const tmp = `${file}.${process.pid}.${this.writeSeq++}${TMP_SUFFIX}`;
    try {
      await writeFile(tmp, value);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }); // don't leave a stray temp file behind
      throw err;
    }
  }

  /**
   * The value at `key`. Never throws: a missing key, an empty key, or an fs
   * error all come back as `{ ok: false, error }`.
   */
  async getValue(key: string): Promise<Result<string>> {
    try {
      const value = await readFile(this.keyToPath(key), "utf8");
      return { ok: true, value };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return { ok: false, error: `no value at key "${key}"` };
      }
      return { ok: false, error: message(err) };
    }
  }

  /** Remove the value at `key`. No-op if there's nothing there. */
  async deleteValue(key: string): Promise<void> {
    await rm(this.keyToPath(key), { force: true });
  }

  /**
   * Every key that starts with `prefix`, in no particular order. An empty
   * prefix lists all keys. Never throws — an fs error comes back as
   * `{ ok: false, error }`.
   */
  async listKeysWithPrefix(prefix: string): Promise<Result<string[]>> {
    let entries;
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true });
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(TMP_SUFFIX)) continue;
      const key = decodeKey(entry.name);
      if (key !== undefined && key.startsWith(prefix)) keys.push(key);
    }
    return { ok: true, value: keys };
  }

  private keyToPath(key: string): string {
    return path.join(this.dataDir, encodeKey(key));
  }
}

/**
 * Encode a key as a single safe filename. `encodeURIComponent` handles `/` and
 * other separators; we additionally escape `.` so a key can never become `.`,
 * `..`, or a dotfile, and so the temp-file suffix stays unambiguous. The mapping
 * is reversible via {@link decodeKey}.
 */
function encodeKey(key: string): string {
  if (key === "") throw new Error("database key must be non-empty");
  return encodeURIComponent(key).replaceAll(".", "%2E");
}

/** Inverse of {@link encodeKey}; undefined if `name` isn't a valid encoding. */
function decodeKey(name: string): string | undefined {
  try {
    return decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
