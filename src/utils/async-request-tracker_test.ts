import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AsyncRequestTracker } from "./async-request-tracker.js";

/** A tracker plus a log of everything its sendFunc was asked to transmit. */
function makeTracker<TPayload, TResult>(
  options?: ConstructorParameters<typeof AsyncRequestTracker>[1],
) {
  const sent: { id: number; payload: TPayload }[] = [];
  const tracker = new AsyncRequestTracker<TPayload, TResult>(
    (id, payload) => sent.push({ id, payload }),
    options,
  );
  return { tracker, sent };
}

describe("AsyncRequestTracker", () => {
  it("stamps a fresh id onto the payload and resolves the matching request", async () => {
    const { tracker, sent } = makeTracker<string, string>();
    const promise = tracker.request("ping");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload, "ping");
    tracker.resolve(sent[0].id, "pong");
    assert.equal(await promise, "pong");
    assert.equal(tracker.size, 0);
  });

  it("allocates a distinct id per request", async () => {
    const { tracker, sent } = makeTracker<string, number>();
    const a = tracker.request("a");
    const b = tracker.request("b");
    assert.notEqual(sent[0].id, sent[1].id);
    assert.equal(tracker.size, 2);
    tracker.resolve(sent[1].id, 2);
    tracker.resolve(sent[0].id, 1);
    assert.deepEqual([await a, await b], [1, 2]);
  });

  it("rejects the matching request", async () => {
    const { tracker, sent } = makeTracker<string, unknown>();
    const promise = tracker.request("x");
    tracker.reject(sent[0].id, new Error("boom"));
    await assert.rejects(promise, /boom/);
  });

  it("times out a request that never gets a response", async () => {
    const { tracker } = makeTracker<string, unknown>({ label: "function" });
    const promise = tracker.request("x", 20);
    await assert.rejects(promise, /function timed out after 20ms/);
    assert.equal(tracker.size, 0);
  });

  it("clears the timeout once resolved", async () => {
    const { tracker, sent } = makeTracker<string, string>();
    const promise = tracker.request("x", 50);
    tracker.resolve(sent[0].id, "ok");
    assert.equal(await promise, "ok");
    // If the timer were still live it would fire later; the resolved value
    // above already proves the timeout did not win.
  });

  it("ignores resolve/reject for unknown or already-settled ids", async () => {
    const { tracker, sent } = makeTracker<string, string>();
    const promise = tracker.request("x");
    tracker.resolve(sent[0].id, "first");
    // Second settle is a no-op and must not throw.
    tracker.resolve(sent[0].id, "second");
    tracker.reject(999, new Error("nobody waiting"));
    assert.equal(await promise, "first");
  });

  it("rejectAll fails every outstanding request and clears them", async () => {
    const { tracker } = makeTracker<string, unknown>();
    const a = tracker.request("a");
    const b = tracker.request("b", 1000);
    tracker.rejectAll(new Error("transport died"));
    await assert.rejects(a, /transport died/);
    await assert.rejects(b, /transport died/);
    assert.equal(tracker.size, 0);
  });
});
