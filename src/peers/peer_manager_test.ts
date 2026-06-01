import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PeerManager, type FunctionGateway } from "./peer_manager.js";
import { AbstractPeer, type CallResult, type PeerManagerHandle } from "./peer.js";

// A gateway exposing one interface "api" with a single func "ping". executeFunc
// echoes its input so tests can assert the call reached through.
const gateway: FunctionGateway = {
  getInterface: (name) => (name === "api" ? { funcs: ["ping"] } : undefined),
  executeFunc: async (funcName, inData) => ({
    ok: true,
    value: `ran:${funcName}(${inData})`,
  }),
};

/**
 * In-memory peer. Records outgoing calls and exposes its callbacks so a test can
 * simulate an inbound call (the other side invoking us) without real IPC.
 */
class TestPeer extends AbstractPeer {
  readonly sent: { funcName: string; inData: string }[] = [];
  closed = false;
  constructor(callbacks: PeerManagerHandle) {
    super(callbacks);
  }
  async sendRpc(funcName: string, inData: string): Promise<CallResult> {
    this.sent.push({ funcName, inData });
    return { ok: true, value: `echo:${funcName}` };
  }
  receive(funcName: string, inData: string): Promise<CallResult> {
    return this.managerHandle.invokeFunction(funcName, inData);
  }
  close(): void {
    this.closed = true;
  }
}

/** Attach a TestPeer to `pm` under `name` and hand back the live instance. */
async function attachTestPeer(pm: PeerManager, name: string): Promise<TestPeer> {
  let peer!: TestPeer;
  await pm.attachPeer(name, (cb) => (peer = new TestPeer(cb)));
  return peer;
}

describe("PeerManager", () => {
  let dir: string;
  let pm: PeerManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "elf-pm-"));
    pm = new PeerManager(dir, gateway);
    await pm.start();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers a peer and reports its connection state", async () => {
    await attachTestPeer(pm, "child");
    assert.deepEqual(pm.listPeers(), ["child"]);
    assert.deepEqual(pm.getPeer("child"), {
      name: "child",
      interfaceName: null,
      connected: true,
    });
  });

  it("rejects invalid peer names", async () => {
    await assert.rejects(() => attachTestPeer(pm, "../evil"));
  });

  it("sends outbound calls through the connection", async () => {
    const peer = await attachTestPeer(pm, "child");
    const res = await pm.callPeer("child", "ping", "{}");
    assert.deepEqual(res, { ok: true, value: "echo:ping" });
    assert.deepEqual(peer.sent, [{ funcName: "ping", inData: "{}" }]);
  });

  it("errors when calling an unknown or disconnected peer", async () => {
    assert.equal((await pm.callPeer("ghost", "ping", "{}")).ok, false);
    await attachTestPeer(pm, "child");
    pm.detachPeer("child");
    assert.equal((await pm.callPeer("child", "ping", "{}")).ok, false);
  });

  describe("access control on inbound calls", () => {
    it("allows a call to a function in the assigned interface", async () => {
      const peer = await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "api");
      assert.deepEqual(await peer.receive("ping", "42"), {
        ok: true,
        value: "ran:ping(42)",
      });
    });

    it("denies a call when no interface is assigned", async () => {
      const peer = await attachTestPeer(pm, "child");
      const res = await peer.receive("ping", "42");
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, /no interface assigned/);
    });

    it("denies a function outside the assigned interface", async () => {
      const peer = await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "api");
      const res = await peer.receive("notListed", "42");
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, /not in interface "api"/);
    });

    it("denies a call when the assigned interface no longer exists", async () => {
      const peer = await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "gone");
      const res = await peer.receive("ping", "42");
      assert.equal(res.ok, false);
      assert.match(res.ok ? "" : res.error, /no longer exists/);
    });
  });

  describe("connection lifecycle", () => {
    it("detach closes the connection but keeps the binding", async () => {
      const peer = await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "api");
      pm.detachPeer("child");
      assert.equal(peer.closed, true);
      assert.equal(pm.isConnected("child"), false);
      assert.equal(pm.getPeerInterface("child"), "api"); // binding survives
    });

    it("reattach reapplies the remembered interface", async () => {
      await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "api");
      pm.detachPeer("child");

      const reconnected = await attachTestPeer(pm, "child");
      assert.equal(pm.isConnected("child"), true);
      // The binding carried over, so an inbound call is allowed straight away.
      assert.equal((await reconnected.receive("ping", "{}")).ok, true);
    });

    it("attaching again closes the previous connection", async () => {
      const first = await attachTestPeer(pm, "child");
      await attachTestPeer(pm, "child");
      assert.equal(first.closed, true);
    });

    it("removePeer forgets the binding entirely", async () => {
      const peer = await attachTestPeer(pm, "child");
      await pm.setPeerInterface("child", "api");
      await pm.removePeer("child");
      assert.equal(peer.closed, true);
      assert.deepEqual(pm.listPeers(), []);
      assert.equal(pm.getPeerInterface("child"), null);
    });
  });
});

describe("PeerManager persistence", () => {
  it("restores interface bindings across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "elf-pm-persist-"));
    try {
      const first = new PeerManager(dir, gateway);
      await first.start();
      await attachTestPeer(first, "child");
      await first.setPeerInterface("child", "api");

      // A fresh manager over the same dir reloads the binding — but, since a
      // connection can't persist, the peer comes back disconnected.
      const second = new PeerManager(dir, gateway);
      await second.start();
      assert.deepEqual(second.listPeers(), ["child"]);
      assert.equal(second.getPeerInterface("child"), "api");
      assert.equal(second.isConnected("child"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
