// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCallLogEntry, McpServerDefinition } from "../../../../automation/contracts";
import { McpCallLogsPanel, type McpCallLogsApi } from "./mcp-call-logs-panel";

function makeLog(overrides: Partial<McpCallLogEntry> = {}): McpCallLogEntry {
  return {
    id: "log-1",
    startedAt: 1_700_000_000_000,
    durationMs: 42,
    client: "cursor",
    mode: "direct",
    sourceId: "playwright",
    sourceName: "Playwright",
    toolName: "navigate",
    argsSummary: '{"url":"https://example.com"}',
    status: "ok",
    responseBytes: 256,
    ...overrides,
  };
}

function makeServer(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "playwright",
    name: "Playwright",
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp"],
    env: {},
    enabled: true,
    tools: [{ name: "navigate", inputSchema: { type: "object" } }],
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function typeInto(input: HTMLInputElement | null, value: string): Promise<void> {
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("McpCallLogsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("loads logs, receives live pushes, filters by status/search, restarts failing servers, and clears logs", async () => {
    const initialLogs: McpCallLogEntry[] = [
      makeLog({
        id: "log-err",
        toolName: "click",
        status: "error",
        error: "Element not found",
        durationMs: 120,
      }),
      makeLog({
        id: "log-ok",
        mode: "builtin",
        client: "claude",
        sourceId: "agent-recall-session-search",
        sourceName: "AgentRecall Session Search",
        toolName: "search_sessions",
        argsSummary: '{"query":"mcp hub"}',
        status: "ok",
      }),
    ];

    let pushLogs: ((logs: McpCallLogEntry[]) => void) | undefined;
    const api: McpCallLogsApi = {
      listMcpCallLogs: vi.fn(async () => initialLogs),
      clearMcpCallLogs: vi.fn(async () => []),
      onMcpCallLogs: vi.fn((callback) => {
        pushLogs = callback;
        return () => {
          pushLogs = undefined;
        };
      }),
      restartMcpServer: vi.fn(async () => makeServer()),
    };

    await act(async () => {
      root.render(createElement(McpCallLogsPanel, {
        language: "en",
        switcher: null,
        api,
      }));
    });

    expect(api.listMcpCallLogs).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("click");
    expect(container.textContent).toContain("Element not found");

    // Restart server button is available for external server error entries
    const restartButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Restart server"),
    );
    expect(restartButton).toBeTruthy();
    await act(async () => {
      restartButton!.click();
    });
    expect(api.restartMcpServer).toHaveBeenCalledWith("playwright");
    expect(container.textContent).toContain('Restarted "Playwright" (1 tools).');

    // Filter to OK only hides the failed entry
    const okTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
      (button) => button.textContent?.includes("OK"),
    );
    expect(okTab).toBeTruthy();
    await act(async () => {
      okTab!.click();
    });
    expect(container.textContent).toContain("search_sessions");
    expect(container.textContent).not.toContain("Element not found");

    // Live push adds a new OK call
    await act(async () => {
      pushLogs?.([
        makeLog({ id: "log-new", toolName: "screenshot", status: "ok" }),
        ...initialLogs,
      ]);
    });
    expect(container.textContent).toContain("screenshot");

    // Search narrows the list
    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    await typeInto(searchInput, "screenshot");
    expect(container.textContent).toContain("screenshot");
    expect(container.textContent).not.toContain("search_sessions");

    // Clear removes all logs
    const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="Clear call logs"]');
    expect(clearButton).toBeTruthy();
    await act(async () => {
      clearButton!.click();
    });
    expect(api.clearMcpCallLogs).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("No MCP tool calls yet");
  });
});
