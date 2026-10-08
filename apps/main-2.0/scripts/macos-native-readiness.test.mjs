import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { waitForMacosAppReadiness } from "./macos-native-readiness.mjs";

const missing = channel => new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`);
function fixture(overrides = {}) {
  const counts = {};
  const defaults = {
    listMcpServers: () => [], getLiveSessions: () => [], getStats: () => ({}),
    getHealth: () => ({ state: "ready" }),
    getIndexStatus: () => ({ running: false, lastIndexedAt: 1, error: null }),
  };
  const methods = Object.fromEntries(Object.entries(defaults).map(([name, call]) => [name, () => {
    counts[name] = (counts[name] ?? 0) + 1;
    return (overrides[name] ?? call)(counts[name]);
  }]));
  const renderer = vm.createContext({ window: { sessionSearch: { ...methods, automation: methods } } });
  const electron = { BrowserWindow: { getAllWindows: () => [{ webContents: {
    getURL: () => "file:///renderer/index.html",
    executeJavaScript: code => structuredClone(vm.runInContext(code, renderer)),
  } }] } };
  return { counts, evaluate: async expression => vm.runInNewContext(expression, { electron }) };
}

test("ready IPCs, healthy services and settled indexing succeed", async () => {
  const f = fixture();
  assert.deepEqual(await waitForMacosAppReadiness(f.evaluate, "electron"), {
    ipc: { state: "ready" }, health: { state: "ready" },
    index: { running: false, lastIndexedAt: 1, error: null },
  });
  assert.equal(f.counts.getStats, 1);
});

for (const method of ["listMcpServers", "getLiveSessions", "getStats", "getHealth", "getIndexStatus"]) {
  test(`retries missing ${method} registration and then becomes ready`, async () => {
    const f = fixture({ [method]: count => {
      if (count === 1) throw missing(method);
      if (method === "getHealth") return { state: "ready" };
      if (method === "getIndexStatus") return { running: false, lastIndexedAt: 1, error: null };
      return [];
    } });
    assert.equal((await waitForMacosAppReadiness(f.evaluate, "electron")).ipc.state, "ready");
    assert.equal(f.counts[method], 2);
  });
}

for (const [name, overrides, error] of [
  ["IPC rejection", { getStats: () => { throw Error("database unavailable"); } }, /database unavailable/],
  ["health error", { getHealth: () => ({ state: "error", message: "startup failed" }) }, /startup failed/],
  ["index error", { getIndexStatus: () => ({ running: true, error: "index failed" }) }, /index failed/],
  ["similar product message", { getStats: () => { throw Error("No handler registered for 'product'"); } }, /Core readiness failed/],
]) {
  test(`${name} fails without retry even when another IPC never settles`, async () => {
    const f = fixture({ listMcpServers: () => new Promise(() => {}), ...overrides });
    await assert.rejects(waitForMacosAppReadiness(f.evaluate, "electron"), error);
    assert.equal(f.counts.getStats, 1);
  });
}

test("inspector transport errors fail immediately", async () => {
  await assert.rejects(waitForMacosAppReadiness(async () => { throw Error("inspector disconnected"); }, "electron"), /inspector disconnected/);
});

for (const [name, overrides] of [
  ["missing handler", { getStats: () => { throw missing("stats"); } }],
  ["pending IPC", { getStats: () => new Promise(() => {}) }],
  ["index still running", { getIndexStatus: () => ({ running: true, lastIndexedAt: null, error: null }) }],
]) {
  test(`${name} remains bounded by the original 60 second deadline`, async t => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    const f = fixture(overrides);
    await assert.rejects(waitForMacosAppReadiness(async expression => {
      const result = await f.evaluate(expression);
      now += 10_000;
      return result;
    }, "electron"), /timed out after 60000ms/);
    assert.equal(now, 60_000);
    if (name === "pending IPC") assert.equal(f.counts.getStats, 1);
    if (name === "missing handler") assert.ok(f.counts.getStats > 1);
  });
}
