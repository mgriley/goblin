/**
 * NotesManager — an elf's persistent, human-readable scratchpad.
 *
 * The AI "brain" needs somewhere to record durable notes it can re-read on
 * startup to remember its purpose, ongoing tasks, and accumulated memory. Each
 * note is just `name => string`; there's no schema, no execution, nothing
 * clever — it's deliberately the simplest manager in the system.
 *
 * Persistence follows the same shape as FunctionManager: the in-memory map is
 * the source of truth at runtime, and every change is mirrored to disk so an elf
 * restores all of its notes on restart. Here the note's content *is* its file,
 * so there's no separate manifest — one file per note is enough:
 *   notes/<name>.md
 *
 * On restart we simply read the directory back in; the filename (minus `.md`) is
 * the note name. Note names must be valid filenames, so they're restricted to
 * the same safe, portable subset the other managers use.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Names double as filenames, so keep them to a safe, portable subset (the same
// rule FunctionManager and PeerManager use).
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const NOTE_EXT = ".md";

export class NotesManager {
  private readonly notes = new Map<string, string>();
  private readonly notesDir: string;
  private started = false;

  constructor(rootDir: string) {
    this.notesDir = path.join(rootDir, "notes");
  }

  /**
   * Restore persisted notes from disk. Call once before any other method;
   * subsequent calls are a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.notesDir, { recursive: true });
    await this.restore();
    this.started = true;
  }

  /**
   * Set a note's content, creating it if absent or overwriting it if present.
   * Unlike FunctionManager.createFunc this is an upsert — "set" has no notion of
   * a duplicate.
   */
  async setNote(name: string, content: string): Promise<void> {
    assertValidName(name);
    await writeFile(this.notePath(name), content);
    this.notes.set(name, content);
  }

  /** The note's content, or undefined if there's no such note. */
  getNote(name: string): string | undefined {
    return this.notes.get(name);
  }

  /** Remove a note. No-op if it doesn't exist. */
  async deleteNote(name: string): Promise<void> {
    if (!this.notes.has(name)) return;
    this.notes.delete(name);
    await rm(this.notePath(name), { force: true });
  }

  /** The names of all notes, in no particular order. */
  listNotes(): string[] {
    return [...this.notes.keys()];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private notePath(name: string): string {
    return path.join(this.notesDir, `${name}${NOTE_EXT}`);
  }

  private async restore(): Promise<void> {
    const entries = await readdir(this.notesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(NOTE_EXT)) continue;
      const name = path.basename(entry.name, NOTE_EXT);
      // Ignore stray files whose names we could never have written, so a junk
      // file dropped in the dir can't become an unaddressable "note".
      if (!VALID_NAME.test(name)) continue;
      const content = await readFile(path.join(this.notesDir, entry.name), "utf8");
      this.notes.set(name, content);
    }
  }
}

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `invalid note name "${name}": must match ${VALID_NAME} (used as a filename)`,
    );
  }
}
