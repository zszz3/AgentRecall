import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { writeNodeCliLauncher } from "../../platform/test-cli-fixtures";
import { CodexRpcClient } from "./codex-rpc";

describe("CodexRpcClient", () => {
  test("includes stderr when Codex exits while an RPC is pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-rpc-"));
    const executable = await writeNodeCliLauncher(
      dir,
      "codex-fail",
      'process.stderr.write("app-server failed: bad args\\n");\nprocess.exit(1);\n',
    );

    const client = new CodexRpcClient({
      executable,
      cwd: dir,
      onEvent: () => undefined,
    });

    await expect(client.start()).rejects.toThrow("app-server failed: bad args");
  });

  test("interrupts a live turn through turn/cancel", async () => {
    const client = new CodexRpcClient({
      executable: "codex",
      cwd: process.cwd(),
      onEvent: () => undefined,
    });
    const request = vi.spyOn(client, "request").mockResolvedValue({});
    const shutdown = vi.spyOn(client, "shutdown").mockResolvedValue();

    await client.interruptTurn("thread-1", "turn-1");

    expect(request).toHaveBeenCalledWith("turn/cancel", { threadId: "thread-1", turnId: "turn-1" });
    expect(shutdown).not.toHaveBeenCalled();
  });

  test("falls back to shutdown when there is no active turn id", async () => {
    const client = new CodexRpcClient({
      executable: "codex",
      cwd: process.cwd(),
      onEvent: () => undefined,
    });
    const request = vi.spyOn(client, "request").mockResolvedValue({});
    const shutdown = vi.spyOn(client, "shutdown").mockResolvedValue();

    await client.interruptTurn("thread-1", undefined);

    expect(request).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  test("falls back to shutdown when turn/cancel fails", async () => {
    const client = new CodexRpcClient({
      executable: "codex",
      cwd: process.cwd(),
      onEvent: () => undefined,
    });
    const request = vi.spyOn(client, "request").mockRejectedValue(new Error("cancel failed"));
    const shutdown = vi.spyOn(client, "shutdown").mockResolvedValue();

    await client.interruptTurn("thread-1", "turn-1");

    expect(request).toHaveBeenCalledWith("turn/cancel", { threadId: "thread-1", turnId: "turn-1" });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
