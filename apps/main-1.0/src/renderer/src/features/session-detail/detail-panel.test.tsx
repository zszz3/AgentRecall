// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionSearchResult, SessionTraceEvent } from "../../../../core/types";
import { storeToolEventsVisibility } from "../../tool-events-visibility";
import { DetailPanel } from "./detail-panel";

describe("DetailPanel Code Mode tool groups", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    storeToolEventsVisibility(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderTraceEvents(traceEvents: SessionTraceEvent[]): Promise<void> {
    await act(async () => {
      root.render(createElement(DetailPanel, {
        session: {
          sessionKey: "codex:code-mode-group",
          rawId: "code-mode-group",
          source: "codex-cli",
          projectPath: "/repo",
          filePath: "/repo/session.jsonl",
          originalTitle: "Code Mode group",
          firstQuestion: "inspect the skill",
          timestamp: Date.parse("2026-08-13T09:17:00.000Z"),
          fileMtimeMs: 0,
          fileSize: 0,
          prUrl: null,
          prNumber: null,
          environmentId: "local",
          environmentKind: "local",
          environmentLabel: "Local",
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
          customTitle: null,
          displayTitle: "Code Mode group",
          favorited: false,
          hidden: false,
          tags: [],
          matchSnippet: null,
          lastOpenedAt: null,
          lastResumedAt: null,
          lastActivityAt: Date.parse("2026-08-13T09:17:00.136Z"),
          messageCount: 0,
          aiSummary: null,
          aiSummaryStale: false,
        } satisfies SessionSearchResult,
        messages: [],
        matchedMessageIndex: null,
        traceEvents,
        loading: false,
        actionStatus: null,
        query: "",
        liveState: "closed",
        language: "zh",
        revealLabel: "文件管理器",
        showItermAction: false,
        messagePageSize: 100,
        olderMessageCount: 0,
        newerMessageCount: 0,
        onClose: () => undefined,
        onShowMore: () => undefined,
        onShowNewer: () => undefined,
        onRename: () => undefined,
        onAddTag: () => undefined,
        onRemoveTag: () => undefined,
        onFavorite: () => undefined,
        onSummarize: () => undefined,
        summarizing: false,
        canResume: false,
        canMigrate: false,
        migrationTitle: "",
        onResume: () => undefined,
        onResumeIterm: () => undefined,
        onMigrate: () => undefined,
        onCopyResume: () => undefined,
        onCopyMarkdown: () => undefined,
        onExportMarkdown: () => undefined,
        onExportJson: () => undefined,
        onCopyPlain: () => undefined,
        onDelete: () => undefined,
        onReveal: () => undefined,
        sessionFamily: { parent: null, children: [], truncated: false },
      }));
    });
  }

  it("shows each parsed tool after its runtime result inside exec", async () => {
    const commands = [
      "sed -n '1,260p' pr.md",
      "rg --files .github",
      "git show --stat --oneline HEAD",
      "git log --oneline origin/main..HEAD",
      "sed -n '1,160p' .release-notes/structured-tool-call.md",
    ];
    const runtimeEvents: SessionTraceEvent[] = commands.map((cmd, index) => ({
      index: index + 1,
      kind: "tool_result",
      source: "codex",
      title: "exec_command",
      detail: JSON.stringify({ cmd, exitCode: 0 }),
      timestamp: `2026-08-13T09:17:00.0${index + 1}0Z`,
      callId: `runtime-${index}`,
      eventType: "codex.command_execution",
      status: "completed",
      attributes: {
        input: { cmd },
        tool: {
          canonicalName: "exec_command",
          executionEvidence: "runtime-confirmed",
          parentCallId: "call-code-mode",
          parsedFromCodeMode: true,
        },
      },
    }));
    const traceEvents: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "tool_call",
        source: "codex",
        title: "exec · exec_command",
        detail: "await Promise.all([...])",
        timestamp: "2026-08-13T09:17:00.000Z",
        callId: "call-code-mode",
        eventType: "codex.custom_tool",
        status: "unknown",
        attributes: {
          nestedTools: ["exec_command"],
          tool: {
            canonicalName: "exec",
            executionEvidence: "recorded-request",
          },
        },
      },
      ...runtimeEvents,
    ];

    await renderTraceEvents(traceEvents);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".conversation-tools-toggle")?.click();
    });

    const group = container.querySelector<HTMLDetailsElement>(".trace-event-group");
    expect(group).not.toBeNull();
    expect(container.querySelectorAll(".conversation > .trace-event")).toHaveLength(1);
    expect(container.querySelectorAll(".conversation > .trace-event.completed")).toHaveLength(0);
    expect(group?.open).toBe(false);
    expect(group?.querySelectorAll(".trace-parsed-results")).toHaveLength(0);
    expect(group?.querySelectorAll(".trace-child-result")).toHaveLength(5);
    expect(group?.querySelectorAll(".trace-child-result > .trace-event.completed")).toHaveLength(5);
    expect(group?.querySelectorAll(".trace-child-result > .trace-parsed-result")).toHaveLength(5);
    expect(group?.querySelectorAll(".trace-code-mode-origin")).toHaveLength(1);

    await act(async () => {
      group?.querySelector<HTMLElement>(":scope > .trace-head")?.click();
    });

    expect(group?.open).toBe(true);
    expect(group?.textContent).toContain("AST 静态解析 · 5 个调用");
    expect(group?.textContent).toContain("调用归属与代码参数来自 exec AST；状态和输出来自运行时记录");
    expect(group?.querySelectorAll(".trace-parsed-result-label")).toHaveLength(5);
    for (const command of commands) expect(group?.textContent).toContain(command);
    expect(group?.textContent).not.toContain("静态识别");
  });

  it("shows terminal legacy Codex tool results instead of request-only evidence", async () => {
    const statuses = ["completed", "failed", "aborted"] as const;
    const traceEvents: SessionTraceEvent[] = statuses.map((status, index) => ({
      index,
      kind: "tool_result",
      source: "codex",
      title: `legacy-${status}`,
      detail: "legacy output",
      timestamp: `2026-08-13T09:17:00.00${index}Z`,
      callId: `legacy-${status}`,
      eventType: "codex.function_call",
      status,
      attributes: {
        tool: {
          canonicalName: "exec_command",
          executionEvidence: "recorded-request",
        },
      },
    }));

    await renderTraceEvents(traceEvents);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".conversation-tools-toggle")?.click();
    });

    const rendered = [...container.querySelectorAll<HTMLElement>(".conversation > .trace-event")];
    expect(rendered).toHaveLength(3);
    expect(rendered.map((event) => event.querySelector(".trace-symbol")?.textContent)).toEqual(["✓", "✗", "■"]);
    expect(rendered.map((event) => event.querySelector(".trace-status-label")?.textContent)).toEqual([
      "已完成",
      "失败",
      "已中断",
    ]);
    expect(rendered.every((event) => !event.textContent?.includes("已请求"))).toBe(true);
  });
});
