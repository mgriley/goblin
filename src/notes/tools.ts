/**
 * Agent tool-calls for NotesManager — lets the LLM brain read, write, delete,
 * and list its persistent notes (purpose, tasks, memory, etc.).
 */

import type { Tool } from "../agent/llm.js";
import type { NotesManager } from "./notes_manager.js";

export function notesManagerTools(nm: NotesManager): Tool[] {
  return [
    {
      name: "note_set",
      description: "Create or overwrite a note. Use this to record purpose, in-progress " +
        "tasks, accumulated memory, or any other information to retain across restarts.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Note name (letters, digits, _ -)." },
          content: { type: "string", description: "Note content (plain text or markdown)." },
        },
      },
      handler: async (args) => {
        try {
          await nm.setNote(args.name as string, args.content as string);
          return `Note "${args.name as string}" saved.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "note_get",
      description: "Read a note by name. Returns the content, or an error if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Note name to read." },
        },
      },
      handler: async (args) => {
        const content = nm.getNote(args.name as string);
        return content !== undefined ? content : `No note named "${args.name as string}".`;
      },
    },

    {
      name: "note_delete",
      description: "Delete a note. No-op if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Note name to delete." },
        },
      },
      handler: async (args) => {
        try {
          await nm.deleteNote(args.name as string);
          return `Note "${args.name as string}" deleted.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "note_list",
      description: "List the names of all saved notes.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = nm.listNotes();
        return names.length ? names.join(", ") : "(none)";
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
