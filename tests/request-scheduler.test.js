import test from "node:test";
import assert from "node:assert/strict";
import { RequestScheduler } from "../dist/RequestScheduler.js";

function createMonitor(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(nextState) {
      state = nextState;
      for (const listener of listeners) {
        listener({ state: nextState, latency: 10, downlink: 10, rtt: 10 });
      }
    },
  };
}

test("holds requests while offline and sends them after recovery", async () => {
  const monitor = createMonitor("offline");
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  };

  const scheduler = new RequestScheduler({ monitor });
  try {
    const pending = scheduler.fetch("https://example.test/resource");
    assert.equal(calls, 0);

    monitor.setState("good");
    const response = await pending;

    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  } finally {
    scheduler.destroy();
    globalThis.fetch = originalFetch;
  }
});

test("rejects queued requests when the scheduler is destroyed", async () => {
  const monitor = createMonitor("offline");
  const scheduler = new RequestScheduler({ monitor });
  const pending = scheduler.fetch("https://example.test/resource");

  scheduler.destroy();

  await assert.rejects(pending, /scheduler détruit/);
});
