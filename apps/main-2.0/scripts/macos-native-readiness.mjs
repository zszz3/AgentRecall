import { setTimeout as delay } from "node:timers/promises";

export async function waitForMacosAppReadiness(evaluate, electron) {
  // Poll without awaiting an unbounded renderer IPC. Only the exact Electron
  // missing-handler error is startup-in-progress; product/transport errors fail.
  const renderer = `(${electron}.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'))).webContents`;
  const probe = `(() => {
    let probe = globalThis.__agentRecallCoreReady;
    if (probe) {
      if (probe.state !== 'pending' && probe.state !== 'error') delete globalThis.__agentRecallCoreReady;
      return probe;
    }
    probe = globalThis.__agentRecallCoreReady = { state: 'pending' };
    const results = {};
    const calls = {
      mcp: () => window.sessionSearch.automation.listMcpServers(),
      live: () => window.sessionSearch.getLiveSessions(),
      stats: () => window.sessionSearch.getStats(),
      health: () => window.sessionSearch.automation.getHealth(),
      index: () => window.sessionSearch.getIndexStatus(),
    };
    let missingHandler = false;
    Promise.all(Object.entries(calls).map(([name, call]) => Promise.resolve().then(call).then(value => {
      if ((name === 'health' && value.state === 'error') || (name === 'index' && value.error != null)) {
        throw new Error(JSON.stringify(value));
      }
      results[name] = value;
    }).catch(error => {
      const message = String(error);
      if (/^Error: Error invoking remote method '([^']+)': Error: No handler registered for '\\1'$/.test(message)) {
        missingHandler = true;
      } else {
        probe.state = 'error';
        probe.error = message;
      }
    }))).then(() => {
      if (probe.state === 'error') return;
      Object.assign(probe, { state: missingHandler ? 'starting' : 'settled',
        ipc: { state: missingHandler ? 'loading' : 'ready' }, health: results.health, index: results.index });
    });
    return probe;
  })()`;
  const readyDeadline = Date.now() + 60_000;
  let readiness;
  while (Date.now() < readyDeadline) {
    readiness = await evaluate(`${renderer}.executeJavaScript(${JSON.stringify(probe)})`);
    if (readiness.state === "error") throw new Error(`Core readiness failed: ${readiness.error}`);
    if (readiness.state === "settled" && readiness.health.state === "ready"
      && !readiness.index.running && Number.isFinite(readiness.index.lastIndexedAt)) {
      return { ipc: readiness.ipc, health: readiness.health, index: readiness.index };
    }
    await delay(100);
  }
  throw new Error(`Core readiness timed out after 60000ms: ${JSON.stringify(readiness)}`);
}
