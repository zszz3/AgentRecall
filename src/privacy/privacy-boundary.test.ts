import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivacyDiagnosticsRegistration } from "./registration";

const temporaryRoots: string[] = [];

async function temporaryHome(): Promise<string> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "agent-recall-privacy-boundary-"));
  temporaryRoots.push(homeDir);
  return homeDir;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("privacy boundary", () => {
  it("exposes upstream sessions through a detached, frozen, read-only API", async () => {
    const homeDir = await temporaryHome();
    const sessionPath = path.join(homeDir, "upstream-session.json");
    await writeFile(sessionPath, `${JSON.stringify({ key: "s1", messages: [{ text: "hello" }] })}\n`, "utf8");
    const beforeContent = await readFile(sessionPath, "utf8");
    const beforeStat = await stat(sessionPath);

    const registration = createPrivacyDiagnosticsRegistration({
      list: async () => [{ key: "s1", filePath: sessionPath }],
      read: async (sessionKey: string) => sessionKey === "s1"
        ? JSON.parse(await readFile(sessionPath, "utf8")) as { key: string; messages: Array<{ text: string }> }
        : null,
    });

    expect(Reflect.ownKeys(registration.upstreamSessions)).toEqual(["operations", "list", "read"]);
    expect(registration.upstreamSessions.operations).toEqual(["list", "read"]);
    expect(Reflect.ownKeys(registration.upstreamSessions).some((key) =>
      /delete|remove|unlink|write/i.test(String(key)))).toBe(false);

    const listed = await registration.upstreamSessions.list();
    const detail = await registration.upstreamSessions.read("s1");
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail?.messages)).toBe(true);
    expect(() => {
      if (detail) detail.messages[0].text = "changed";
    }).toThrow();

    expect(await readFile(sessionPath, "utf8")).toBe(beforeContent);
    const afterStat = await stat(sessionPath);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("does not reach network-capable update or advanced task callbacks when disabled", async () => {
    const registration = createPrivacyDiagnosticsRegistration({
      list: () => [],
      read: () => null,
    });
    const checkForUpdates = vi.fn();
    const startAdvancedTasks = vi.fn();

    await expect(registration.afterFirstWindowReady(
      { automaticUpdateChecks: false, advancedTasks: false },
      { checkForUpdates, startAdvancedTasks },
    )).resolves.toEqual({ updateCheck: "disabled", advancedTasks: "disabled" });

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(startAdvancedTasks).not.toHaveBeenCalled();
  });

  it("runs optional work only when each preference explicitly enables it", async () => {
    const registration = createPrivacyDiagnosticsRegistration({
      list: () => [],
      read: () => null,
    });
    const checkForUpdates = vi.fn();
    const startAdvancedTasks = vi.fn();

    await registration.afterFirstWindowReady(
      { automaticUpdateChecks: true, advancedTasks: false },
      { checkForUpdates, startAdvancedTasks },
    );
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(startAdvancedTasks).not.toHaveBeenCalled();
  });
});
