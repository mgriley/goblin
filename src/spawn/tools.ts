/**
 * Agent tool-calls for SpawnManager — lets the LLM brain spawn child elves,
 * remove them, and inspect what's currently running.
 *
 * `spawnAllExisting` and `terminate` are startup/internal operations and are
 * intentionally not exposed here.
 */

import type { Tool } from "../agent/llm.js";
import type { SpawnManager } from "./spawn_manager.js";

export function spawnManagerTools(sm: SpawnManager): Tool[] {
  return [
    {
      name: "spawn_actor",
      description:
        "Spawn a new child elf with the given name and purpose. The child runs as an " +
        "independent process with its own workspace, managers, and agent loop. It is " +
        "registered as a peer so you can assign it an interface and call its functions. " +
        "The purpose is written to the child's Purpose note and guides its agent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Child name (letters, digits, _ -). Also its peer name." },
          purpose: { type: "string", description: "Plain-text description of what this child elf should do." },
        },
      },
      handler: async (args) => {
        try {
          await sm.spawnActor(args.name as string, args.purpose as string);
          return `Child elf "${args.name as string}" spawned.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "remove_actor",
      description:
        "Terminate a child elf and delete its workspace. The child is removed as a peer " +
        "and will not be respawned on restart. Use with care — the workspace is gone permanently.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Child name to remove." },
        },
      },
      handler: async (args) => {
        try {
          await sm.removeActor(args.name as string);
          return `Child elf "${args.name as string}" removed.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "list_running",
      description: "List the names of all child elves currently running under this elf.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = sm.listRunning();
        return names.length ? names.join(", ") : "(none)";
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
