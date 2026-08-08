import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("application shutdown wiring", () => {
  it("runs asynchronous cleanup once and stops PostgreSQL after closing the pool", async () => {
    const source = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    const preventQuit = source.indexOf("event.preventDefault();");
    const markQuitStarted = source.indexOf("automationQuitStarted = true;");
    const cancelStartupTasks = source.indexOf("startupTasks.cancelAll();", markQuitStarted);
    const shutdownAutomation = source.indexOf("automationService?.shutdown()", markQuitStarted);
    const adoptInflightRuntime = source.indexOf(
      "postgresRuntime = await postgresRuntimeStartup.catch(() => null);",
      shutdownAutomation,
    );
    const closeDatabase = source.indexOf("postgresDatabase?.close()", adoptInflightRuntime);
    const stopRuntime = source.indexOf("postgresRuntime?.stop()", closeDatabase);
    const markQuitReady = source.indexOf("automationQuitReady = true;", stopRuntime);

    expect(preventQuit).toBeGreaterThan(-1);
    expect(markQuitStarted).toBeGreaterThan(preventQuit);
    expect(cancelStartupTasks).toBeGreaterThan(markQuitStarted);
    expect(shutdownAutomation).toBeGreaterThan(cancelStartupTasks);
    expect(adoptInflightRuntime).toBeGreaterThan(shutdownAutomation);
    expect(closeDatabase).toBeGreaterThan(adoptInflightRuntime);
    expect(stopRuntime).toBeGreaterThan(closeDatabase);
    expect(markQuitReady).toBeGreaterThan(stopRuntime);
  });

  it("aborts the startup chain once quit started", async () => {
    const source = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    const registerStartup = source.indexOf("postgresRuntimeStartup = startPostgresRuntime(");
    const runtimeAwait = source.indexOf("postgresRuntime = await postgresRuntimeStartup;", registerStartup);
    const runtimeCheckpoint = source.indexOf("if (automationQuitStarted) return;", runtimeAwait);
    const pruneSources = source.indexOf("await pruneDisabledOptionalSources(getSettings());", runtimeCheckpoint);
    const setupCheckpoint = source.indexOf("if (automationQuitStarted) return;", pruneSources);
    const registerIpc = source.indexOf("registerIpc();", setupCheckpoint);

    expect(registerStartup).toBeGreaterThan(-1);
    expect(runtimeAwait).toBeGreaterThan(registerStartup);
    expect(runtimeCheckpoint).toBeGreaterThan(runtimeAwait);
    expect(pruneSources).toBeGreaterThan(runtimeCheckpoint);
    expect(setupCheckpoint).toBeGreaterThan(pruneSources);
    expect(registerIpc).toBeGreaterThan(setupCheckpoint);
  });
});
