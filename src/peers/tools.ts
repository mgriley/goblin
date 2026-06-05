/**
 * Agent tool-calls for PeerManager — lets the LLM brain inspect peers, assign
 * interfaces, and call functions on connected peers.
 *
 * Lifecycle operations (attachPeer, detachPeer, removePeer) are intentionally
 * omitted: those are managed by SpawnManager and PortsManager, not the agent.
 */

import type { Tool } from "../agent/llm.js";
import type { PeerManager } from "./peer_manager.js";

export function peerManagerTools(pm: PeerManager): Tool[] {
  return [
    {
      name: "peer_set_interface",
      description:
        "Assign an interface to a peer, controlling which functions it may call. " +
        "Pass null to revoke all access. The peer must already exist (created by " +
        "SpawnManager or PortsManager).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Peer name." },
          interfaceName: {
            type: "optional",
            inner: { type: "string" },
            description: "Interface to assign, or null to clear.",
          },
        },
      },
      handler: async (args) => {
        try {
          await pm.setPeerInterface(
            args.name as string,
            (args.interfaceName as string | null) ?? null,
          );
          const iface = args.interfaceName as string | null;
          return iface
            ? `Peer "${args.name as string}" assigned interface "${iface}".`
            : `Peer "${args.name as string}" interface cleared.`;
        } catch (err) {
          return error(err);
        }
      },
    },

    {
      name: "peer_get",
      description: "Return a peer's current interface assignment and connection status.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Peer name." },
        },
      },
      handler: async (args) => {
        const peer = pm.getPeer(args.name as string);
        if (!peer) return `No peer named "${args.name as string}".`;
        return JSON.stringify(peer, null, 2);
      },
    },

    {
      name: "peer_list",
      description: "List the names of all known peers (connected or not).",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const names = pm.listPeers();
        return names.length ? names.join(", ") : "(none)";
      },
    },

    {
      name: "peer_call",
      description:
        "Call a function on a connected peer and return its response. " +
        "`inputData` is JSON-encoded. Returns the JSON-encoded output, or an error.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Peer name." },
          funcName: { type: "string", description: "Function to call on the peer." },
          inputData: { type: "string", description: "JSON-encoded input value." },
        },
      },
      handler: async (args) => {
        const result = await pm.callPeer(
          args.name as string,
          args.funcName as string,
          args.inputData as string,
        );
        return result.ok ? result.value : `Error: ${result.error}`;
      },
    },
  ];
}

function error(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
