/**
 * Database — an goblin's private key/value store for whatever data it needs to
 * keep (customer accounts, app state, …).
 *
 * The interface is a deliberately plain hierarchical KV store: keys are
 * slash-separated path strings (e.g. `customers/123/name`), values are strings.
 * Four operations:
 *   - setValue(key, value)        upsert
 *   - getValue(key)               -> Result<string>
 *   - deleteValue(key)            idempotent
 *   - listKeysWithPrefix(prefix)  -> Result<string[]>
 *
 * Keys must match VALID_KEY: segments of [A-Za-z0-9_-] joined by `/`. This
 * strict allowlist means slashes are the only character that needs escaping on
 * disk, and the mapping is trivially reversible.
 *
 * Unlike the other managers, this one does NOT cache in memory: customer data
 * can be large and unbounded, so disk is the source of truth and every read and
 * write hits the underlying files directly.
 *
 * On-disk layout: a single flat directory, one file per entry, whose filename
 * is the key with `/` replaced by `#`:
 *   database/customers#123#name
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
import { Logger } from "../utils/logger.js";

// Key segments: alphanumeric, underscore, hyphen; segments joined by `/`.
const VALID_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

// Temp files for atomic writes live alongside their target with this suffix.
// Valid keys never contain "." so this suffix can never collide with a real
// entry and lets listing skip in-flight writes.
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
    Logger.logEvent({ category: "database", action: "set", target: key, details: { value } });
  }

  /**
   * The value at `key`. Never throws: a missing key, an empty key, or an fs
   * error all come back as `{ ok: false, error }`.
   */
  async getValue(key: string): Promise<Result<string>> {
    Logger.logEvent({ category: "database", action: "read", target: key });
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
    Logger.logEvent({ category: "database", action: "deleted", target: key });
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
      if (!entry.isFile()) continue;
      const key = filenameToKey(entry.name);
      if (key !== undefined && key.startsWith(prefix)) keys.push(key);
    }
    return { ok: true, value: keys };
  }

  private keyToPath(key: string): string {
    return path.join(this.dataDir, keyToFilename(key));
  }
}

/** Key → filename: replace `/` with `#`. Throws if the key is invalid. */
function keyToFilename(key: string): string {
  if (!VALID_KEY.test(key)) throw new Error(`invalid database key: "${key}" — keys must match ${VALID_KEY} (alphanumeric/underscore/hyphen segments separated by "/")`);
  return key.replaceAll("/", "#");
}

/** Filename → key: replace `#` with `/`. Returns undefined for non-entry files (e.g. temp files). */
function filenameToKey(name: string): string | undefined {
  if (name.endsWith(TMP_SUFFIX)) return undefined;
  return name.replaceAll("#", "/");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
