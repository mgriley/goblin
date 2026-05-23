import { readdir, stat } from "node:fs/promises";
import path from "node:path";

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
