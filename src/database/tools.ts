/**
 * Agent tool-calls for Database — lets the LLM brain read, write, delete, and
 * list entries in the elf's private KV store.
 */

import type { Tool } from "../agent/llm.js";
import type { Database } from "./database.js";

export function databaseTools(db: Database): Tool[] {
  return [
    {
      name: "db_set",
      description: "Create or overwrite a value in the database. Keys can use " +
        "path-style names (e.g. `users/42/name`) to stay organized.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to set." },
          value: { type: "string", description: "The string value to store." },
        },
      },
      handler: async (args) => {
        try {
          await db.setValue(args.key as string, args.value as string);
          return `Set "${args.key as string}".`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "db_get",
      description: "Read the value at a key. Returns the value, or an error if the key doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to read." },
        },
      },
      handler: async (args) => {
        const result = await db.getValue(args.key as string);
        return result.ok ? result.value : `Error: ${result.error}`;
      },
    },

    {
      name: "db_delete",
      description: "Delete the value at a key. No-op if the key doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to delete." },
        },
      },
      handler: async (args) => {
        try {
          await db.deleteValue(args.key as string);
          return `Deleted "${args.key as string}".`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "db_list",
      description: "List all keys that start with a given prefix. Pass an empty string to list all keys.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Key prefix to filter by. Use \"\" to list everything." },
        },
      },
      handler: async (args) => {
        const result = await db.listKeysWithPrefix(args.prefix as string);
        if (!result.ok) return `Error: ${result.error}`;
        return result.value.length ? result.value.join("\n") : "(none)";
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
