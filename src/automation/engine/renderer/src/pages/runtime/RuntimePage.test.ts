import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentChannel } from "../../../../shared/types";
import { RuntimePage } from "./RuntimePage";

const channels: AgentChannel[] = [
  {
    id: "codex-openai",
    agentId: "codex",
    label: "Codex OpenAI",
    providerName: "OpenAI",
    models: [],
  },
  {
    id: "claude-code",
    agentId: "claude",
    label: "Claude Code",
    providerName: "claude-code",
    models: [],
  },
];

describe("RuntimePage", () => {
  it("lists Runtime configs in a secondary sidebar and keeps selected details concise", () => {
    const markup = renderToStaticMarkup(createElement(RuntimePage, {
      embedded: true,
      language: "zh",
      channels,
      selectedChannelId: "codex-openai",
      selectedRuntimeId: "codex",
      providerKeys: {},
      codexPluginCatalog: [],
      pluginCatalogStatus: "",
      agentTestResults: {},
      testingAgentId: undefined,
      agentTestTick: 0,
      onUpdateChannel: vi.fn(),
      onAddModel: vi.fn(),
      onUpdateModel: vi.fn(),
      onRemoveModel: vi.fn(),
      onSave: vi.fn(),
      onLoadCodexPluginCatalog: vi.fn(),
      onSelectChannel: vi.fn(),
      onSelectRuntime: vi.fn(),
      onAddConfig: vi.fn(),
      onDeleteConfig: vi.fn(),
      onTestChannel: vi.fn(),
      onUpdateProviderKey: vi.fn(),
    }));

    expect(markup).not.toContain('class="runtime-config-toolbar"');
    expect(markup).toContain('class="runtime-config-sidebar"');
    expect(markup).toContain('<strong>当前配置</strong>');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-label="选择执行器类型"');
    expect(markup).toContain('data-runtime-choice="codex"');
    expect(markup).toContain('data-runtime-choice="claude"');
    expect(markup).toContain('data-runtime-choice="api"');
    expect(markup).toContain('data-runtime-choice="hermes"');
    expect(markup).toContain('data-runtime-choice="opencode"');
    expect(markup).toContain('data-runtime-choice="openclaw"');
    expect(markup).toContain('class="runtime-sidebar-item is-active"');
    expect(markup).toContain("Codex OpenAI");
    expect(markup).toContain("Claude Code");
    expect(markup).not.toContain('class="runtime-selector"');
    expect(markup).not.toContain('aria-label="选择配置"');
    expect(markup).not.toContain("runtime-channel-row");
    expect(markup).toContain('class="runtime-config-summary');
    expect(markup).toContain("更换 Provider");
    expect(markup).toContain("OpenAI");
    expect(markup).not.toContain('aria-label="Provider presets"');
    expect(markup).toContain('class="runtime-config-disclosure runtime-models-disclosure"');
    expect(markup).toContain('class="runtime-config-disclosure runtime-plugins-disclosure"');
  });
});
