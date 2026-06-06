/**
 * Agent tool-calls for PortsManager — lets the LLM brain open and close HTTP
 * listening ports. Each port automatically gets a `handleRequest_<name>` handler
 * function (modifiable via FunctionManager tools) and an `http_<name>` interface.
 */

import type { Tool } from "../agent/llm.js";
import type { PortsManager } from "./ports_manager.js";

export function portsManagerTools(pm: PortsManager): Tool[] {
  return [
    {
      name: "port_open",
      description:
        "Open a listening HTTP port. Automatically creates a `handleRequest_<name>` " +
        "function (default: hello-world) and an `http_<name>` interface. " +
        "These are the designated entry points for all request handling on this port — " +
        "use `modify_func` to update `handleRequest_<name>` with your routing/response logic, " +
        "and grant peers access via the `http_<name>` interface. Do not create separate " +
        "handler functions or interfaces for a port; use the ones that were auto-created. " +
        "`host` defaults to loopback (127.0.0.1); pass \"0.0.0.0\" to accept external connections.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Port name (used to reference it later)." },
          port: { type: "integer", description: "TCP port number. Use 0 to pick an ephemeral port." },
          host: {
            type: "optional",
            inner: { type: "string" },
            description: "Bind address. Defaults to 127.0.0.1. Pass null to use the default.",
          },
        },
      },
      handler: async (args) => {
        try {
          await pm.openPort(args.name as string, {
            port: args.port as number,
            host: (args.host as string | null) ?? undefined,
          });
          const bound = pm.getPort(args.name as string);
          return `Port "${args.name as string}" listening on port ${bound}.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "port_close",
      description:
        "Stop listening on a port but keep its record, peer binding, and handler " +
        "function so it can be reopened later.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Port name to close." },
        },
      },
      handler: async (args) => {
        pm.closePort(args.name as string);
        return `Port "${args.name as string}" closed.`;
      },
    },

    {
      name: "port_remove",
      description:
        "Close a port and forget it entirely, removing its peer, handler function, and interface.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Port name to remove." },
        },
      },
      handler: async (args) => {
        try {
          await pm.removePort(args.name as string);
          return `Port "${args.name as string}" removed.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "port_list",
      description: "List the names of all currently listening ports.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = pm.listListening();
        return names.length ? names.join(", ") : "(none)";
      },
    },

    {
      name: "port_get",
      description: "Return the bound TCP port number for a listening port.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Port name." },
        },
      },
      handler: async (args) => {
        const port = pm.getPort(args.name as string);
        return port !== undefined
          ? `Port "${args.name as string}" is bound to ${port}.`
          : `Port "${args.name as string}" is not currently listening.`;
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
