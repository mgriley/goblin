import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { HttpPeer } from "./http_peer.js";
import type { CallResult, PeerManagerHandle } from "./peer.js";

/** A managerHandle whose response is swapped per test; records inbound calls. */
class FakeHandle implements PeerManagerHandle {
  readonly calls: { funcName: string; inData: string }[] = [];
  next: CallResult = { ok: true, value: "{}" };
  async invokeFunction(funcName: string, inData: string): Promise<CallResult> {
    this.calls.push({ funcName, inData });
    return this.next;
  }
}

describe("HttpPeer", () => {
  let server: Server;
  let peer: HttpPeer;
  let handle: FakeHandle;
  let base: string;

  beforeEach(async () => {
    handle = new FakeHandle();
    server = createServer();
    peer = new HttpPeer(server, handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    peer.close();
  });

  it("serves a health check on GET /", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(handle.calls.length, 0); // never reaches the function gate
  });

  it("forwards POST /<funcName> to invokeFunction and returns the value", async () => {
    handle.next = { ok: true, value: '{"pong":true}' };
    const res = await fetch(`${base}/ping`, { method: "POST", body: "42" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"pong":true}');
    assert.deepEqual(handle.calls, [{ funcName: "ping", inData: "42" }]);
  });

  it("treats an empty body as empty inData", async () => {
    await fetch(`${base}/ping`, { method: "POST" });
    assert.deepEqual(handle.calls, [{ funcName: "ping", inData: "" }]);
  });

  it("maps error results onto HTTP statuses", async () => {
    const cases: [string, number][] = [
      ['peer "x" has no interface assigned', 403],
      ['no function named "ping"', 404],
      ['function "ping" is not in interface "api"', 404],
      ["input is not valid JSON", 400],
      ["boom at runtime", 500],
    ];
    for (const [error, status] of cases) {
      handle.next = { ok: false, error };
      const res = await fetch(`${base}/ping`, { method: "POST", body: "{}" });
      assert.equal(res.status, status, `"${error}" -> ${status}`);
      assert.equal(await res.text(), error);
    }
  });

  it("rejects non-POST methods with 405", async () => {
    const res = await fetch(`${base}/ping`, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(handle.calls.length, 0);
  });

  it("rejects POST with no function name", async () => {
    const res = await fetch(`${base}/`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    assert.equal(handle.calls.length, 0);
  });

  it("is inbound-only: sendRpc always fails", async () => {
    const res = await peer.sendRpc();
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /inbound-only/);
  });
});
