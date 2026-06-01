import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { validate, type ObjectSchema } from "./utils/schema.js";
import type { Elf } from "./elf.js";
import type { Tool } from "./agent/llm.js";

const execFileAsync = promisify(execFile);

const runBashParams = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: 'The CLI tool to invoke (e.g. "ls", "cat", "grep").',
    },
    args: {
      type: "string",
      description:
        'Arguments as a single string (e.g. "-la /tmp"). May be empty.',
    },
  },
} satisfies ObjectSchema;

export const runBashCommandTool: Tool = {
  name: "run_bash_command",
  description:
    "Run a single CLI tool (e.g. `ls`, `cat`, `grep`) in the elf's working " +
    "directory. Provide the tool's name and an args string.",
  parameters: runBashParams,
  handler: async (rawArgs) => {
    const { name, args } = validate(runBashParams, rawArgs) as {
      name: string;
      args: string;
    };
    const command = args ? `${name} ${args}` : name;
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command]);
      return formatBashResult(0, stdout, stderr);
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | null;
      };
      return formatBashResult(e.code ?? null, e.stdout ?? "", e.stderr ?? "");
    }
  },
};

function formatBashResult(
  code: number | null,
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = [`exit code: ${code ?? "?"}`];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tools bound to a specific Elf instance.
// ---------------------------------------------------------------------------

const createChildParams = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Unique short name for the child (becomes its dir name and id).",
    },
    purpose: {
      type: "string",
      description:
        "Initial instruction/purpose written to the child's purpose.md.",
    },
  },
} satisfies ObjectSchema;

const deleteChildParams = {
  type: "object",
  properties: {
    elfId: {
      type: "string",
      description: "Id (name) of the child to terminate.",
    },
  },
} satisfies ObjectSchema;

const sendMessageToChildParams = {
  type: "object",
  properties: {
    elfId: {
      type: "string",
      description: "Id (name) of the child to send to.",
    },
    message: {
      type: "string",
      description: "Message body sent to the child.",
    },
  },
} satisfies ObjectSchema;

const sendMessageToParentParams = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "Message body sent to the parent.",
    },
  },
} satisfies ObjectSchema;

/**
 * Build the set of tools that close over a specific Elf — spawn/kill children
 * and send messages up and down the hierarchy.
 */
export function createElfTools(elf: Elf): Tool[] {
  return [
    {
      name: "create_child",
      description:
        "Spawn a new child elf as a forked subprocess. The child gets its " +
        "own workspace directory and a `purpose.md` describing its goal. " +
        "Fails if a child with this name already exists.",
      parameters: createChildParams,
      handler: async (rawArgs) => {
        const { name, purpose } = validate(createChildParams, rawArgs) as {
          name: string;
          purpose: string;
        };
        await elf.createChild(name, purpose);
        return `Spawned child "${name}".`;
      },
    },

    {
      name: "delete_child",
      description:
        "Terminate a child elf (SIGTERM) and remove it from the registry. " +
        "Safe to call on an unknown id (no-op).",
      parameters: deleteChildParams,
      handler: async (rawArgs) => {
        const { elfId } = validate(deleteChildParams, rawArgs) as {
          elfId: string;
        };
        await elf.deleteChild(elfId);
        return `Child "${elfId}" is no longer running.`;
      },
    },

    {
      name: "send_message_to_child",
      description:
        "Send a message to a child elf and wait for its response. Returns " +
        "an explanatory string if no child with that id exists.",
      parameters: sendMessageToChildParams,
      handler: async (rawArgs) => {
        const { elfId, message } = validate(
          sendMessageToChildParams,
          rawArgs,
        ) as { elfId: string; message: string };
        const response = await elf.sendMessageToChild(elfId, message);
        if (response === undefined) {
          return `No child with id "${elfId}".`;
        }
        return response;
      },
    },

    {
      name: "send_message_to_parent",
      description:
        "Send a message to this elf's parent and wait for its response. " +
        "Returns an explanatory string when this elf has no parent (root).",
      parameters: sendMessageToParentParams,
      handler: async (rawArgs) => {
        const { message } = validate(sendMessageToParentParams, rawArgs) as {
          message: string;
        };
        const response = await elf.sendMessageToParent(message);
        if (response === undefined) {
          return "This elf has no parent (it is the root).";
        }
        return response;
      },
    },
  ];
}
