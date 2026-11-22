// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHealthReport } from "../../../../core/remote-health";
import type { SessionEnvironment } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import { useEnvironmentActions, type EnvironmentActions } from "./use-environment-actions";

const ssh = { id: "ssh:box", kind: "ssh", label: "box" } as SessionEnvironment;

describe("useEnvironmentActions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: EnvironmentActions;
  let status: ActionStatus | null;
  const reload = vi.fn(async () => undefined);
  const onRemoved = vi.fn();
  const api = {
    refreshEnvironment: vi.fn(async () => undefined),
    diagnoseEnvironment: vi.fn(async () => ({ ok: false, summary: "SSH login failed." }) as RemoteHealthReport),
    deleteEnvironment: vi.fn(async () => undefined),
    saveEnvironment: vi.fn(),
  };

  function Harness() {
    const [current, setStatus] = useState<ActionStatus | null>(null);
    status = current;
    actions = useEnvironmentActions({ api, setStatus, reload, onRemoved, t: (en) => en });
    return null;
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the health report of a checked environment until the environment is deleted", async () => {
    await act(async () => actions.diagnose(ssh));
    expect(actions.healthReports["ssh:box"]?.summary).toBe("SSH login failed.");
    expect(actions.diagnosingId).toBeNull();
    expect(status).toEqual({ kind: "error", message: "SSH login failed." });

    await act(async () => actions.remove(ssh));
    expect(actions.healthReports["ssh:box"]).toBeUndefined();
    expect(onRemoved).toHaveBeenCalledWith(ssh);
    expect(reload).toHaveBeenCalledOnce();
    expect(status).toEqual({ kind: "success", message: "box deleted." });
  });

  it("reports a failed save and rejects so the dialog keeps its input", async () => {
    api.saveEnvironment.mockRejectedValueOnce(new Error("Host is unreachable."));

    let rejected: unknown;
    await act(async () => {
      await actions.save({ kind: "wsl", label: "Ubuntu", wslDistribution: "Ubuntu" }).catch((error: unknown) => {
        rejected = error;
      });
    });

    expect(rejected).toBeInstanceOf(Error);
    expect(reload).not.toHaveBeenCalled();
    expect(status).toEqual({ kind: "error", message: "Host is unreachable." });
  });
});
