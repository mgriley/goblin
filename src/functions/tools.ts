/**
 * Agent tool-calls for FunctionManager — lets the LLM brain create, inspect,
 * modify, and execute the elf's functions, interfaces, and shared libs.
 *
 * Each tool wraps one FunctionManager operation. Errors are caught and returned
 * as strings so the agent can read what went wrong and self-correct rather than
 * crashing the tool loop.
 *
 * Usage: pass the result of {@link functionManagerTools} to Agent's tool list.
 */

import type { Tool } from "../agent/llm.js";
import type { JsonSchema } from "../utils/schema.js";
import type { FunctionManager } from "./function_manager.js";

export function functionManagerTools(fm: FunctionManager): Tool[] {
  return [
    ...funcTools(fm),
    ...interfaceTools(fm),
    ...sharedLibTools(fm),
    ...syscallTools(fm),
  ];
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function funcTools(fm: FunctionManager): Tool[] {
  return [
    {
      name: "create_func",
      description:
        "Create a new function. `code` must be an ES module that exports an async " +
        "`handle(input, libs)` function. `inputSchema` and `outputSchema` are JSON Schema " +
        "objects describing the expected input and output shapes. Optionally list shared " +
        "lib names to inject as the `libs` argument.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function name (letters, digits, _ -)." },
          code: { type: "string", description: "ES module source exporting `handle(input, libs)`." },
          inputSchema: { type: "object", properties: {}, description: "JSON Schema for the input." },
          outputSchema: { type: "object", properties: {}, description: "JSON Schema for the output." },
          sharedLibs: {
            type: "optional",
            inner: { type: "array", items: { type: "string" } },
            description: "Shared lib names to inject. Pass null if none.",
          },
        },
      },
      handler: async (args) => {
        try {
          await fm.createFunc(
            args.name as string,
            args.code as string,
            args.inputSchema as JsonSchema,
            args.outputSchema as JsonSchema,
            (args.sharedLibs as string[] | null) ?? [],
          );
          return `Function "${args.name as string}" created.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "modify_func",
      description: "Replace a function's code. The function is hot-reloaded; " +
        "the change rolls back automatically if the new code fails to load.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the function to update." },
          code: { type: "string", description: "New ES module source." },
        },
      },
      handler: async (args) => {
        try {
          await fm.modifyFunc(args.name as string, args.code as string);
          return `Function "${args.name as string}" updated.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "remove_func",
      description: "Delete a function and drop it from any interface that listed it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the function to remove." },
        },
      },
      handler: async (args) => {
        try {
          await fm.removeFunc(args.name as string);
          return `Function "${args.name as string}" removed.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "get_func",
      description: "Return a function's code and schemas, or an error if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the function." },
        },
      },
      handler: async (args) => {
        const def = fm.getFunc(args.name as string);
        if (!def) return `No function named "${args.name as string}".`;
        return JSON.stringify({ name: def.name, code: def.code, inputSchema: def.inputSchema, outputSchema: def.outputSchema, sharedLibs: def.sharedLibs }, null, 2);
      },
    },

    {
      name: "list_funcs",
      description: "List the names of all defined functions.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = fm.listFuncs();
        return names.length ? names.join(", ") : "(none)";
      },
    },

    {
      name: "execute_func",
      description:
        "Execute a function by name. `inputData` is the JSON-encoded input " +
        "(use \"null\" for functions that take no input). Returns the JSON-encoded output, " +
        "or an error string.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the function to run." },
          inputData: { type: "string", description: "JSON-encoded input value." },
        },
      },
      handler: async (args) => {
        try {
          const result = await fm.executeFunc(args.name as string, args.inputData as string);
          return result.ok ? result.value : `Error: ${result.error}`;
        } catch (err) {
          return error(err);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

function interfaceTools(fm: FunctionManager): Tool[] {
  return [
    {
      name: "create_interface",
      description:
        "Create a named interface grouping existing functions. Assigning this interface " +
        "to a peer grants that peer access to exactly those functions. By default, a peer does not have access to any functions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Interface name." },
          funcs: { type: "array", items: { type: "string" }, description: "Function names to include." },
        },
      },
      handler: async (args) => {
        try {
          await fm.createInterface(args.name as string, args.funcs as string[]);
          return `Interface "${args.name as string}" created.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "modify_interface",
      description: "Replace the function membership of an interface.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Interface name." },
          funcs: { type: "array", items: { type: "string" }, description: "New function list." },
        },
      },
      handler: async (args) => {
        try {
          await fm.modifyInterface(args.name as string, args.funcs as string[]);
          return `Interface "${args.name as string}" updated.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "remove_interface",
      description: "Delete an interface. Peers that had it assigned lose their access.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Interface name to remove." },
        },
      },
      handler: async (args) => {
        try {
          await fm.removeInterface(args.name as string);
          return `Interface "${args.name as string}" removed.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "get_interface",
      description: "Return an interface's function list, or an error if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Interface name." },
        },
      },
      handler: async (args) => {
        const iface = fm.getInterface(args.name as string);
        if (!iface) return `No interface named "${args.name as string}".`;
        return JSON.stringify(iface, null, 2);
      },
    },

    {
      name: "list_interfaces",
      description: "List the names of all defined interfaces.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = fm.listInterfaces();
        return names.length ? names.join(", ") : "(none)";
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared libs
// ---------------------------------------------------------------------------

function sharedLibTools(fm: FunctionManager): Tool[] {
  return [
    {
      name: "create_shared_lib",
      description:
        "Create a shared lib — an ES module exporting a single `lib` value that can " +
        "be injected into functions via their `libs` argument. Use for reusable helpers " +
        "shared across multiple functions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lib name." },
          code: { type: "string", description: "ES module source exporting `lib`." },
        },
      },
      handler: async (args) => {
        try {
          await fm.createSharedLib(args.name as string, args.code as string);
          return `Shared lib "${args.name as string}" created.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "modify_shared_lib",
      description:
        "Replace a shared lib's code. Every function that uses it is hot-reloaded automatically.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lib name." },
          code: { type: "string", description: "New ES module source." },
        },
      },
      handler: async (args) => {
        try {
          await fm.modifySharedLib(args.name as string, args.code as string);
          return `Shared lib "${args.name as string}" updated.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "remove_shared_lib",
      description: "Delete a shared lib. Fails if any function still depends on it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lib name to remove." },
        },
      },
      handler: async (args) => {
        try {
          await fm.removeSharedLib(args.name as string);
          return `Shared lib "${args.name as string}" removed.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "get_shared_lib",
      description: "Return a shared lib's code, or an error if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lib name." },
        },
      },
      handler: async (args) => {
        const lib = fm.getSharedLib(args.name as string);
        if (!lib) return `No shared lib named "${args.name as string}".`;
        return JSON.stringify({ name: lib.name, code: lib.code }, null, 2);
      },
    },

    {
      name: "list_shared_libs",
      description: "List the names of all defined shared libs.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = fm.listSharedLibs();
        return names.length ? names.join(", ") : "(none)";
      },
    },

    {
      name: "set_func_shared_libs",
      description:
        "Set the shared libs injected into a function, replacing the previous list. " +
        "The function is reloaded with the new libs immediately.",
      parameters: {
        type: "object",
        properties: {
          funcName: { type: "string", description: "Name of the function." },
          libNames: { type: "array", items: { type: "string" }, description: "Ordered list of lib names to inject." },
        },
      },
      handler: async (args) => {
        try {
          await fm.setFuncSharedLibs(args.funcName as string, args.libNames as string[]);
          return `Shared libs for "${args.funcName as string}" updated.`;
        } catch (err) {
          return error(err);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// System calls
// ---------------------------------------------------------------------------

function syscallTools(fm: FunctionManager): Tool[] {
  return [
    {
      name: "list_syscalls",
      description:
        "List all system calls available to functions at runtime. Each syscall is a " +
        "host-provided capability registered by the elf's main script. " +
        "To call one from function code: `const result = await sys.call(name, input)` — " +
        "`sys` is available at module scope without any import.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const syscalls = fm.listSyscalls();
        if (!syscalls.length) return "(none)";
        return JSON.stringify(syscalls, null, 2);
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
