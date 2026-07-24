import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../core/platform";
import { OpenVikingMemoryPage } from "./features/openviking-memory/openviking-memory-page";
import { OpenVikingMemorySettings } from "./features/settings/openviking-memory-settings";

describe("OpenViking directory memory UI", () => {
  it("shows an opt-in empty state instead of the old rules-file editor", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemoryPage, {
      language: "zh",
      enabled: false,
      onOpenSettings: () => undefined,
    }));

    expect(html).toContain("目录记忆默认关闭");
    expect(html).toContain("前往设置");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("AGENTS.md");
    expect(html).not.toContain("CLAUDE.md");
    expect(html).not.toContain("Cursor Rules");
  });

  it("offers one local model and the three supported lifecycle integrations", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: defaultSettings,
      saving: false,
      onSettingsChange: () => undefined,
    }));

    expect(html).toContain("目录记忆");
    expect(html).toContain("BAAI/bge-small-zh-v1.5");
    expect(html).toContain("47.9 MB");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("OpenCode");
  });

  it("renders live runtime download stages, byte counts and a progress bar", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/settings/openviking-memory-settings.tsx"),
      "utf8",
    );

    expect(source).toContain("openviking-runtime-progress");
    expect(source).toContain("downloadedBytes");
    expect(source).toContain("totalBytes");
    expect(source).toContain("bytesPerSecond");
    expect(source).toContain("installedBytes");
    expect(source).toContain("runtimeInstalledSize");
    expect(source).toContain("${runtimeInstalledSize} / ${runtimeInstalledSize} MB");
    expect(source).not.toContain("Managed runtime");
    expect(source).not.toContain("托管运行时");
    expect(source).not.toContain("system Python");
    expect(source).not.toContain("系统 Python");
    expect(source).toContain("服务运行中");
    expect(source).toContain("服务已停止");
    expect(source).toContain("/s");
    expect(source).toContain("window.setInterval");
    expect(source).toContain('&& action !== "start"');
  });

  it("wires directory management, import control and memory CRUD through the new preload API", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    for (const operation of [
      "chooseOpenVikingDirectory",
      "addOpenVikingWorkspace",
      "pauseOpenVikingImport",
      "resumeOpenVikingImport",
      "searchOpenVikingMemories",
      "saveOpenVikingMemory",
      "deleteOpenVikingMemory",
      "stopManagingOpenVikingWorkspace",
      "deleteOpenVikingWorkspace",
    ]) {
      expect(source).toContain(operation);
    }
    expect(source).toContain('action === "import"');
    expect(source).toContain("正在导入并提取记忆");
    expect(source).toContain("已导入 ${workspace.importedTurns} / ${workspace.totalTurns}");
  });

  it("loads existing memories without requiring a search query", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain('searchOpenVikingMemories(workspace.id, "", 200)');
    expect(source).toContain("browseLoading");
    expect(source).toContain("正在加载已有记忆");
    expect(source).toContain("还没有生成记忆");
  });

  it("bounds the memory browser to the page so long result lists can scroll", async () => {
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(css).toMatch(/\.openviking-memory-page\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/su);
    expect(css).toMatch(/\.openviking-memory-layout\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/su);
    expect(css).toMatch(/\.openviking-memory-browser\s*\{[^}]*grid-template-rows:[^;]*minmax\(0,\s*1fr\);[^}]*min-height:\s*0;/su);
    expect(css).toMatch(/\.openviking-memory-content\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su);
    expect(css).toMatch(/\.openviking-result-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su);
  });
});
