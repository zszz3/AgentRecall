// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentChannel } from "../../../../shared/types";
import { RuntimePage } from "./RuntimePage";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

const deepSeekChannel: AgentChannel = {
  id: "claude-deepseek",
  agentId: "claude",
  label: "Claude Code + DeepSeek",
  presetId: "claude-code-deepseek",
  providerName: "DeepSeek",
  modelProvider: "deepseek-anthropic",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiFormat: "anthropic",
  models: [{ id: "default", label: "Default" }],
};

describe("RuntimePage model discovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test("shows an explicit detect-models action and disables it while the request is running", async () => {
    const request = deferred();
    const onRefreshModels = vi.fn(() => request.promise);

    await act(async () => {
      root.render(
        <RuntimePage
          embedded
          language="zh"
          channels={[deepSeekChannel]}
          selectedChannelId={deepSeekChannel.id}
          selectedRuntimeId="claude"
          providerKeys={{}}
          codexPluginCatalog={[]}
          pluginCatalogStatus=""
          agentTestResults={{}}
          testingAgentId={undefined}
          agentTestTick={0}
          onUpdateChannel={() => undefined}
          onAddModel={() => undefined}
          onUpdateModel={() => undefined}
          onRemoveModel={() => undefined}
          onRefreshModels={onRefreshModels}
          onSave={async () => undefined}
          onLoadCodexPluginCatalog={async () => undefined}
          onSelectChannel={() => undefined}
          onSelectRuntime={() => undefined}
          onAddConfig={() => undefined}
          onDeleteConfig={() => undefined}
          onTestChannel={async () => undefined}
          onUpdateProviderKey={() => undefined}
        />,
      );
    });

    const button = [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.includes("探测模型"));
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);

    await act(async () => button?.click());

    expect(onRefreshModels).toHaveBeenCalledWith(deepSeekChannel.id);
    expect(button?.disabled).toBe(true);

    await act(async () => {
      request.resolve();
      await request.promise;
    });

    expect(button?.disabled).toBe(false);
  });
});
