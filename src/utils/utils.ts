import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Stable content hash of `text`. Used as a cache-busting token in module import
 * URLs: identical code yields the same hash (so the import cache is reused),
 * and any code change yields a new hash (forcing a fresh import). Derived purely
 * from the bytes, so it needs no persistence and survives restarts.
 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A success-or-failure outcome. Lets a function report failure as a value
 * rather than throwing. Carries a `value` of type `T` on
 * success, or a human-readable `error` string on failure.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * True if `dirPath` exists and is a directory; false otherwise.
 * Rethrows any other fs error (e.g. EACCES) rather than swallowing it.
 */
export async function checkIfDirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Return the full paths of every immediate subdirectory of `dirPath`.
 * If `dirPath` does not exist, returns an empty list.
 */
export async function findAllSubdirs(dirPath: string): Promise<string[]> {
  if (!(await checkIfDirExists(dirPath))) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name));
}
