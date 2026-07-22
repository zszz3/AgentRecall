import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentProviderPreset } from "../../../../shared/provider-presets";
import { RuntimeProviderPicker } from "./RuntimeProviderPicker";

const presets: AgentProviderPreset[] = [
  {
    id: "codex-openai",
    label: "OpenAI Official",
    runtimeAgentId: "codex",
    providerName: "OpenAI",
    category: "official",
    models: [],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    runtimeAgentId: "codex",
    providerName: "DeepSeek",
    category: "cn_official",
    models: [],
  },
];

function renderPicker(query: string): string {
  return renderToStaticMarkup(createElement(RuntimeProviderPicker, {
    language: "zh",
    presets,
    selectedPresetId: "codex-openai",
    query,
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
  }));
}

describe("RuntimeProviderPicker", () => {
  it("filters providers using the visible provider identity", () => {
    const markup = renderPicker("open");

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("OpenAI Official");
    expect(markup).not.toContain(">DeepSeek<");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("guides the user when no provider matches", () => {
    const markup = renderPicker("not-a-provider");

    expect(markup).toContain("没有匹配的 Provider");
    expect(markup).not.toContain("OpenAI Official");
    expect(markup).not.toContain(">DeepSeek<");
  });
});
