import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PortsManager } from "./ports_manager.js";
import { PeerManager, type FunctionGateway } from "./peer_manager.js";

// Same shape as peer_manager_test: one interface "api" exposing "ping", which
// echoes its input so we can confirm a request reached all the way through.
const gateway: FunctionGateway = {
  getInterface: (name) => (name === "api" ? { funcs: ["ping"] } : undefined),
  executeFunc: async (funcName, inData) => ({
    ok: true,
    value: `ran:${funcName}(${inData})`,
  }),
};

/** POST to a listening port and return [status, body]. */
async function call(
  pm: PortsManager,
  name: string,
  funcName: string,
  body: string,
): Promise<[number, string]> {
  const res = await fetch(`http://127.0.0.1:${pm.getPort(name)}/${funcName}`, {
    method: "POST",
    body,
  });
  return [res.status, await res.text()];
}

describe("PortsManager", () => {
  let dir: string;
  let peers: PeerManager;
  let ports: PortsManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "elf-ports-"));
    peers = new PeerManager(dir, gateway);
    await peers.start();
    ports = new PortsManager(dir, peers);
    await ports.start();
  });

  afterEach(async () => {
    for (const name of ports.listListening()) ports.closePort(name);
    await rm(dir, { recursive: true, force: true });
  });

  it("opens a port and registers it as a peer", async () => {
    await ports.openPort("public", { port: 0 });
    assert.deepEqual(ports.listListening(), ["public"]);
    assert.deepEqual(peers.getPeer("public"), {
      name: "public",
      interfaceName: null,
      connected: true,
    });
  });

  it("routes an HTTP request through the assigned interface", async () => {
    await ports.openPort("public", { port: 0 });
    await peers.setPeerInterface("public", "api");

    const [status, body] = await call(ports, "public", "ping", "42");
    assert.equal(status, 200);
    assert.equal(body, "ran:ping(42)");
  });

  it("denies a function outside the assigned interface", async () => {
    await ports.openPort("public", { port: 0 });
    await peers.setPeerInterface("public", "api");

    const [status] = await call(ports, "public", "notListed", "{}");
    assert.equal(status, 404); // "not in interface" maps to 404
  });

  it("denies all calls when no interface is assigned", async () => {
    await ports.openPort("public", { port: 0 });
    const [status] = await call(ports, "public", "ping", "{}");
    assert.equal(status, 403); // "no interface assigned"
  });

  it("rejects opening the same name twice while listening", async () => {
    await ports.openPort("public", { port: 0 });
    await assert.rejects(() => ports.openPort("public", { port: 0 }), /already listening/);
  });

  it("rejects an invalid port name", async () => {
    await assert.rejects(() => ports.openPort("../evil", { port: 0 }), /invalid peer name/);
  });

  it("closePort stops serving but keeps the peer + interface", async () => {
    await ports.openPort("public", { port: 0 });
    await peers.setPeerInterface("public", "api");
    const port = ports.getPort("public")!;

    ports.closePort("public");
    assert.deepEqual(ports.listListening(), []);
    assert.equal(peers.getPeerInterface("public"), "api"); // binding survives
    await assert.rejects(fetch(`http://127.0.0.1:${port}/ping`, { method: "POST" }));
  });

  it("removePort forgets the port and its peer", async () => {
    await ports.openPort("public", { port: 0 });
    await ports.removePort("public");
    assert.deepEqual(ports.listListening(), []);
    assert.equal(peers.getPeer("public"), undefined);
  });
});

describe("PortsManager persistence", () => {
  it("reopens persisted ports and reapplies their interface on restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-ports-persist-"));
    try {
      // First run: open a port bound to "api", then simulate shutdown.
      const peers1 = new PeerManager(dir, gateway);
      await peers1.start();
      const ports1 = new PortsManager(dir, peers1);
      await ports1.start();
      await ports1.openPort("public", { port: 0 });
      await peers1.setPeerInterface("public", "api");
      ports1.closePort("public");

      // Fresh managers over the same dir: records + binding reload from disk, and
      // openAllExisting rebinds the socket. The remembered port is reused.
      const peers2 = new PeerManager(dir, gateway);
      await peers2.start();
      const ports2 = new PortsManager(dir, peers2);
      await ports2.start();
      await ports2.openAllExisting();

      assert.deepEqual(ports2.listListening(), ["public"]);
      const [status, body] = await call(ports2, "public", "ping", "7");
      assert.equal(status, 200);
      assert.equal(body, "ran:ping(7)"); // interface carried across the restart

      ports2.closePort("public");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
