// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createTurn(
  id: string,
  turnIndex: number,
  userPreview = `user ${id}`,
  assistantPreview = `assistant ${id}`,
): SessionTurnSummary {
  return {
    id,
    turnIndex,
    sourceMessageIndex: turnIndex * 10,
    sourceTurnId: id,
    synthetic: false,
    status: "completed",
    startedAt: `2026-08-10T10:00:0${turnIndex}.000Z`,
    endedAt: `2026-08-10T10:00:0${turnIndex + 1}.000Z`,
    userPreview,
    assistantPreview,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: 2,
    spanCount: 0,
  };
}

function createTurnDetail(
  turn: SessionTurnSummary,
  userContent = turn.userPreview,
  assistantContent = turn.assistantPreview,
): SessionTurnDetail {
  const sourceMessageIndex = turn.sourceMessageIndex ?? 0;
  return {
    ...turn,
    messages: [
      {
        messageIndex: 0,
        sourceMessageIndex,
        role: "user",
        content: userContent,
        timestamp: turn.startedAt ?? "",
      },
      {
        messageIndex: 1,
        sourceMessageIndex: sourceMessageIndex + 1,
        role: "assistant",
        content: assistantContent,
        timestamp: turn.endedAt ?? "",
      },
    ],
    spans: [],
  };
}

describe("TurnAccordion search match positioning", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  const turn = {
    id: "turn-1",
    turnIndex: 0,
    sourceMessageIndex: 40,
    synthetic: false,
    status: "completed",
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: "2026-08-10T10:00:01.000Z",
    userPreview: "before",
    assistantPreview: "matched phrase",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: 2,
    spanCount: 0,
  } satisfies SessionTurnSummary;

  const detail = {
    ...turn,
    messages: [
      {
        messageIndex: 0,
        sourceMessageIndex: null,
        role: "user",
        content: "before",
        timestamp: turn.startedAt,
      },
      {
        messageIndex: 1,
        sourceMessageIndex: 42,
        role: "assistant",
        content: "matched phrase",
        timestamp: turn.endedAt,
      },
    ],
    spans: [],
  } satisfies SessionTurnDetail;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    scrollIntoView.mockReset();
  });

  it("opens the matching Turn and marks the exact matched message", async () => {
    const onLoadTurn = vi.fn(async () => detail);

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:session-1"
          turns={[turn]}
          loading={false}
          matchedTurnId="turn-1"
          matchedMessageIndex={42}
          showTools
          query="matched phrase"
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onLoadTurn).toHaveBeenCalledWith("turn-1");

    const matchedMessage = container.querySelector(
      '[data-message-index="42"]',
    );

    expect(matchedMessage?.classList.contains("match-target")).toBe(true);
    expect(scrollIntoView.mock.instances).toContain(matchedMessage);
  });

  it("does not mark messages with missing source indexes when no message matched", async () => {
    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:session-1"
          turns={[turn]}
          loading={false}
          matchedTurnId="turn-1"
          matchedMessageIndex={null}
          showTools
          query=""
          language="en"
          onLoadTurn={async () => detail}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".msg.match-target")).toBeNull();
  });
});

describe("TurnAccordion subagent labels", () => {
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

  it("shows lifecycle-backed subagent work as an agent-triggered Turn", async () => {
    const subagentTurn = {
      id: "subagent-turn-1",
      turnIndex: 0,
      sourceMessageIndex: null,
      sourceTurnId: "source-turn-1",
      agentTriggered: true,
      synthetic: true,
      status: "aborted",
      startedAt: "2026-08-12T09:05:00.000Z",
      endedAt: "2026-08-12T09:13:47.000Z",
      userPreview: "",
      assistantPreview: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 0,
      spanCount: 2,
    } satisfies SessionTurnSummary;

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={[subagentTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.textContent).toContain("第 1 轮 · Agent 触发");
    expect(container.textContent).toContain("由 Agent 触发，任务文本未记录");
    expect(container.textContent).not.toContain("前置轨迹");
  });

  it("does not infer an Agent trigger from a source Turn id alone", async () => {
    const lifecycleTurn = {
      id: "background-turn-1",
      turnIndex: 0,
      sourceMessageIndex: null,
      sourceTurnId: "source-turn-1",
      agentTriggered: false,
      synthetic: false,
      status: "completed",
      startedAt: "2026-08-12T09:05:00.000Z",
      endedAt: "2026-08-12T09:06:00.000Z",
      userPreview: "",
      assistantPreview: "background work",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 0,
      spanCount: 0,
    } satisfies SessionTurnSummary;

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={[lifecycleTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.textContent).toContain("第 1 轮");
    expect(container.textContent).not.toContain("Agent 触发");
  });

  it("separates forked parent context from the subagent's own Turns", async () => {
    const turn = (
      id: string,
      turnIndex: number,
      overrides: Partial<SessionTurnSummary> = {},
    ) => ({
      id,
      turnIndex,
      sourceMessageIndex: turnIndex < 2 ? turnIndex : null,
      sourceTurnId: `source-${id}`,
      agentTriggered: false,
      synthetic: false,
      status: "completed" as const,
      startedAt: `2026-08-12T09:0${turnIndex}:00.000Z`,
      endedAt: `2026-08-12T09:0${turnIndex}:30.000Z`,
      userPreview: turnIndex < 2 ? `parent request ${turnIndex + 1}` : "",
      assistantPreview: turnIndex < 2 ? `parent result ${turnIndex + 1}` : `subagent result ${turnIndex - 1}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 1,
      spanCount: 0,
      ...overrides,
    });
    const turns = [
      turn("parent-1", 0),
      turn("parent-2", 1),
      turn("child-1", 2, {
        agentTriggered: true,
        subagentExecutionStart: true,
      }),
      turn("child-2", 3),
    ] satisfies SessionTurnSummary[];

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={turns}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          isSubagent
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.textContent).toContain("继承自父会话的上下文");
    expect(container.textContent).toContain("以下 2 个 Turn 为创建子 Agent 时继承的会话上下文");
    expect(container.textContent).toContain("子 Agent 任务执行");
    expect(container.textContent).toContain("以下 Turn 为该子 Agent 的任务执行记录");
    expect(container.textContent).toContain("父会话第 1 轮 · Fork 继承");
    expect(container.textContent).toContain("子 Agent 第 1 轮 · Agent 触发");
    expect(container.textContent).toContain("子 Agent 第 2 轮");
    expect(container.querySelectorAll('[data-turn-origin="inherited"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-turn-origin="subagent"]')).toHaveLength(2);
  });

  it("labels unnumbered synthetic Turns as Session setup in both subagent sections", async () => {
    const turn = (
      id: string,
      turnIndex: number,
      overrides: Partial<SessionTurnSummary> = {},
    ) => ({
      id,
      turnIndex,
      sourceMessageIndex: turnIndex,
      sourceTurnId: `source-${id}`,
      agentTriggered: false,
      synthetic: false,
      status: "completed" as const,
      startedAt: `2026-08-12T09:0${turnIndex}:00.000Z`,
      endedAt: `2026-08-12T09:0${turnIndex}:30.000Z`,
      userPreview: `request ${turnIndex + 1}`,
      assistantPreview: `result ${turnIndex + 1}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 1,
      spanCount: 0,
      ...overrides,
    });
    const turns = [
      turn("parent-setup", 0, {
        sourceMessageIndex: null,
        sourceTurnId: null,
        synthetic: true,
        userPreview: "",
      }),
      turn("parent-1", 1),
      turn("child-1", 2, {
        sourceMessageIndex: null,
        agentTriggered: true,
        synthetic: true,
        subagentExecutionStart: true,
        userPreview: "",
      }),
      turn("child-setup", 3, {
        sourceMessageIndex: null,
        sourceTurnId: null,
        synthetic: true,
        userPreview: "",
      }),
      turn("child-2", 4),
    ] satisfies SessionTurnSummary[];

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={turns}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          isSubagent
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.textContent?.match(/会话准备/g)).toHaveLength(2);
    expect(container.textContent).toContain("父会话第 1 轮 · Fork 继承");
    expect(container.textContent).toContain("子 Agent 第 1 轮 · Agent 触发");
    expect(container.textContent).toContain("子 Agent 第 2 轮");
    expect(container.textContent).not.toMatch(/第 0 轮/);
  });

  it("does not split Fork vs execution without an incoming NEW_TASK", async () => {
    const turn = (
      id: string,
      turnIndex: number,
      overrides: Partial<SessionTurnSummary> = {},
    ) => ({
      id,
      turnIndex,
      sourceMessageIndex: turnIndex === 2 ? null : turnIndex,
      sourceTurnId: `source-${id}`,
      agentTriggered: turnIndex === 2,
      synthetic: turnIndex === 2,
      status: "completed" as const,
      startedAt: `2026-08-12T09:0${turnIndex}:00.000Z`,
      endedAt: `2026-08-12T09:0${turnIndex}:30.000Z`,
      userPreview: turnIndex === 2 ? "" : `parent request ${turnIndex + 1}`,
      assistantPreview: turnIndex === 2 ? "" : `parent result ${turnIndex + 1}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 1,
      spanCount: 0,
      ...overrides,
    });
    const turns = [
      turn("parent-1", 0),
      turn("parent-2", 1),
      turn("child-1", 2),
    ] satisfies SessionTurnSummary[];

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={turns}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          isSubagent
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.querySelector(".turn-phase-divider")).toBeNull();
    expect(container.querySelector("[data-turn-origin]")).toBeNull();
    expect(container.textContent).not.toContain("继承自父会话的上下文");
    expect(container.textContent).not.toContain("子 Agent 任务执行");
    expect(container.textContent).toContain("第 3 轮 · Agent 触发");
    expect(container.textContent).not.toContain("Fork 继承");
  });

  it("splits only at the first incoming NEW_TASK and ignores a followup NEW_TASK", async () => {
    const turn = (
      id: string,
      turnIndex: number,
      overrides: Partial<SessionTurnSummary> = {},
    ) => ({
      id,
      turnIndex,
      sourceMessageIndex: turnIndex < 2 ? turnIndex : null,
      sourceTurnId: `source-${id}`,
      agentTriggered: turnIndex >= 2,
      synthetic: false,
      status: "completed" as const,
      startedAt: `2026-08-12T09:0${turnIndex}:00.000Z`,
      endedAt: `2026-08-12T09:0${turnIndex}:30.000Z`,
      userPreview: turnIndex < 2 ? `parent request ${turnIndex + 1}` : "",
      assistantPreview: turnIndex < 2 ? `parent result ${turnIndex + 1}` : `subagent result ${turnIndex - 1}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 1,
      spanCount: 0,
      ...overrides,
    });
    const turns = [
      turn("parent-1", 0),
      turn("parent-2", 1),
      turn("child-1", 2, { subagentExecutionStart: true }),
      turn("child-2", 3, { subagentExecutionStart: true }),
    ] satisfies SessionTurnSummary[];

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:subagent-1"
          turns={turns}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          isSubagent
          onLoadTurn={async () => null}
        />,
      );
    });

    expect(container.querySelectorAll(".turn-phase-divider.inherited")).toHaveLength(1);
    expect(container.querySelectorAll(".turn-phase-divider.subagent")).toHaveLength(1);
    expect(container.querySelectorAll('[data-turn-origin="inherited"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-turn-origin="subagent"]')).toHaveLength(2);
    expect(container.textContent).toContain("子 Agent 第 1 轮 · Agent 触发");
    expect(container.textContent).toContain("子 Agent 第 2 轮 · Agent 触发");
  });

  it("keeps nested-fork agentTriggered turns in inherited context until NEW_TASK", async () => {
    const turn = (
      id: string,
      turnIndex: number,
      overrides: Partial<SessionTurnSummary> = {},
    ) => ({
      id,
      turnIndex,
      sourceMessageIndex: null,
      sourceTurnId: `source-${id}`,
      agentTriggered: false,
      synthetic: false,
      status: "completed" as const,
      startedAt: `2026-08-12T09:0${turnIndex}:00.000Z`,
      endedAt: `2026-08-12T09:0${turnIndex}:30.000Z`,
      userPreview: `request ${turnIndex + 1}`,
      assistantPreview: `result ${turnIndex + 1}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 1,
      spanCount: 0,
      ...overrides,
    });
    const turns = [
      turn("parent-1", 0, { sourceMessageIndex: 0, userPreview: "parent request 1" }),
      turn("inherited-trigger", 1, {
        agentTriggered: true,
        userPreview: "",
      }),
      turn("child-1", 2, {
        agentTriggered: true,
        subagentExecutionStart: true,
        userPreview: "",
      }),
    ] satisfies SessionTurnSummary[];

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:nested-subagent"
          turns={turns}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="zh"
          isSubagent
          onLoadTurn={async () => null}
        />,
      );
    });

    const inherited = [...container.querySelectorAll('[data-turn-origin="inherited"]')]
      .map((element) => element.getAttribute("data-turn-id"));
    const subagent = [...container.querySelectorAll('[data-turn-origin="subagent"]')]
      .map((element) => element.getAttribute("data-turn-id"));
    expect(inherited).toEqual(["parent-1", "inherited-trigger"]);
    expect(subagent).toEqual(["child-1"]);
    expect(container.querySelectorAll(".turn-phase-divider.subagent")).toHaveLength(1);
    expect(container.textContent).toContain("父会话第 2 轮 · Fork 继承");
    expect(container.textContent).toContain("子 Agent 第 1 轮 · Agent 触发");
  });
});

describe("TurnAccordion span payloads", () => {
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
    vi.restoreAllMocks();
  });

  it("shows terminal legacy Codex tool results instead of request-only evidence", async () => {
    const turn = createTurn("turn-legacy-status", 0, "run legacy tools", "");
    const statuses = ["completed", "failed", "aborted"] as const;
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spanCount: statuses.length,
      spans: statuses.map((status, index) => ({
        id: `span-${status}`,
        parentSpanId: null,
        spanIndex: index,
        kind: "tool",
        name: `legacy-${status}`,
        status,
        startedAt: `2026-08-13T09:17:00.00${index}Z`,
        endedAt: `2026-08-13T09:17:00.01${index}Z`,
        callId: `legacy-${status}`,
        input: null,
        output: { text: "legacy output" },
        error: status === "failed" ? "failed" : null,
        attributes: {
          tool: {
            canonicalName: "exec_command",
            executionEvidence: "recorded-request",
          },
        },
      })),
    };

    await act(async () => {
      root.render(createElement(TurnAccordion, {
        sessionKey: "codex:legacy-status",
        turns: [turn],
        loading: false,
        matchedTurnId: null,
        matchedMessageIndex: null,
        showTools: true,
        query: "",
        language: "zh",
        onLoadTurn: async () => detail,
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg.tool")).toHaveLength(3);
    });

    const rendered = [...container.querySelectorAll<HTMLElement>(".msg.tool")];
    expect(rendered.map((span) => span.querySelector(".msg-tool-status")?.textContent?.trim())).toEqual([
      "✓ 已完成",
      "✕ 失败",
      "■ 已中断",
    ]);
    expect(rendered.every((span) => !span.classList.contains("evidence-recorded-request"))).toBe(true);
  });

  it("shows each parsed tool after its runtime result inside exec", async () => {
    const commands = [
      "sed -n '1,260p' pr.md",
      "rg --files .github",
      "git show --stat --oneline HEAD",
      "git log --oneline origin/main..HEAD",
      "sed -n '1,160p' .release-notes/structured-tool-call.md",
    ];
    const turn = createTurn("turn-code-mode", 0, "inspect the skill", "");
    const runtimeSpans: SessionTraceSpan[] = commands.map((cmd, index) => ({
      id: `span-runtime-${index}`,
      parentSpanId: "span-exec",
      spanIndex: index + 1,
      kind: "tool",
      name: "exec_command",
      status: "completed",
      startedAt: `2026-08-13T09:17:00.0${index + 1}0Z`,
      endedAt: `2026-08-13T09:17:00.0${index + 1}1Z`,
      callId: `runtime-${index}`,
      input: { cmd },
      output: { exitCode: 0 },
      error: null,
      attributes: {
        title: "exec_command",
        tool: {
          canonicalName: "exec_command",
          executionEvidence: "runtime-confirmed",
          parentCallId: "call-code-mode",
          parsedFromCodeMode: true,
        },
      },
    }));
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spanCount: 6,
      spans: [
        {
          id: "span-exec",
          parentSpanId: null,
          spanIndex: 0,
          kind: "tool",
          name: "exec",
          status: "unknown",
          startedAt: "2026-08-13T09:17:00.000Z",
          endedAt: "2026-08-13T09:17:00.136Z",
          callId: "call-code-mode",
          input: { code: "await tools.exec_command(...)" },
          output: null,
          error: null,
          attributes: {
            title: "exec · exec_command",
            nestedTools: ["exec_command"],
            tool: {
              canonicalName: "exec",
              executionEvidence: "recorded-request",
            },
          },
        },
        ...runtimeSpans,
      ],
    };

    await act(async () => {
      root.render(
        createElement(TurnAccordion, {
          sessionKey: "codex:code-mode-group",
          turns: [turn],
          loading: false,
          matchedTurnId: null,
          matchedMessageIndex: null,
          showTools: true,
          query: "",
          language: "zh",
          onLoadTurn: async () => detail,
        }),
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg-tool-group")).toHaveLength(1);
    });

    const group = container.querySelector<HTMLDetailsElement>(".msg-tool-group");
    expect(group?.open).toBe(false);
    expect(container.querySelectorAll(".turn-timeline-item.span")).toHaveLength(1);
    expect(container.querySelectorAll(".turn-timeline-item.span > .msg.tool.completed")).toHaveLength(0);
    expect(group?.querySelectorAll(".msg-tool-parsed-results")).toHaveLength(0);
    expect(group?.querySelectorAll(".msg-tool-child-result")).toHaveLength(5);
    expect(group?.querySelectorAll(".msg-tool-child-result > .msg.tool.completed")).toHaveLength(5);
    expect(group?.querySelectorAll(".msg-tool-child-result > .msg-tool-parsed-result")).toHaveLength(5);
    expect(group?.querySelectorAll(".msg-tool-code-mode-origin")).toHaveLength(1);

    await act(async () => {
      group?.querySelector<HTMLElement>(":scope > .msg-tool-summary")?.click();
    });

    expect(group?.open).toBe(true);
    expect(group?.textContent).toContain("AST 静态解析 · 5 个调用");
    expect(group?.textContent).toContain("调用归属与代码参数来自 exec AST；状态和输出来自运行时记录");
    expect(group?.querySelectorAll(".msg-tool-parsed-result-label")).toHaveLength(5);
    for (const command of commands) expect(group?.textContent).toContain(command);
    expect(group?.textContent).not.toContain("静态识别");
  });

  it("shows parsed nested tools for Codex exec spans and falls back to the stable tool name", async () => {
    const turn: SessionTurnSummary = {
      id: "turn-exec",
      turnIndex: 0,
      sourceMessageIndex: 0,
      sourceTurnId: "turn-exec",
      synthetic: false,
      status: "completed",
      startedAt: "2026-08-12T04:00:00Z",
      endedAt: "2026-08-12T04:00:01Z",
      userPreview: "inspect tools",
      assistantPreview: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: ["exec"],
      messageCount: 0,
      spanCount: 2,
    };
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spans: [
        {
          id: "span-parsed",
          parentSpanId: null,
          spanIndex: 0,
          kind: "tool",
          name: "exec",
          status: "completed",
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          callId: "call-parsed",
          input: null,
          output: null,
          error: null,
          attributes: {
            title: "exec · exec_command, web.run",
            nestedTools: ["exec_command", "web__run"],
          },
        },
        {
          id: "span-legacy",
          parentSpanId: null,
          spanIndex: 1,
          kind: "tool",
          name: "exec",
          status: "completed",
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          callId: "call-legacy",
          input: null,
          output: null,
          error: null,
          attributes: {
            title: "exec · raw script summary",
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        createElement(TurnAccordion, {
          sessionKey: "codex:exec-display",
          turns: [turn],
          loading: false,
          matchedTurnId: null,
          matchedMessageIndex: null,
          showTools: true,
          query: "",
          language: "en",
          onLoadTurn: async () => detail,
        }),
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg-tool-summary strong")).toHaveLength(2);
    });
    const displayedNames = [...container.querySelectorAll(".msg-tool-summary strong")]
      .map((element) => element.textContent);
    expect(displayedNames).toHaveLength(2);
    expect(displayedNames).toEqual(expect.arrayContaining(["exec · exec_command, web.run", "exec"]));
    expect(turn.toolNames).toEqual(["exec"]);
  });

  it("renders a bounded preview before expanding a large span output", async () => {
    const compactOutput =
      `compact-payload:\n${"readable compact output ".repeat(500)}`;
    const toolOutput =
      `tool-payload:\n${"readable tool output ".repeat(500)}`;

    const turn: SessionTurnSummary = {
      id: "turn-1",
      turnIndex: 0,
      sourceMessageIndex: 0,
      sourceTurnId: "turn-1",
      synthetic: false,
      status: "completed",
      startedAt: "2026-08-10T00:00:00Z",
      endedAt: "2026-08-10T00:00:01Z",
      userPreview: "compact session",
      assistantPreview: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 0,
      spanCount: 2,
    };

    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spans: [
        {
          id: "span-1",
          parentSpanId: null,
          spanIndex: 0,
          kind: "event",
          name: "Context compacted",
          status: "completed",
          startedAt: "2026-08-10T00:00:01Z",
          endedAt: "2026-08-10T00:00:01Z",
          callId: null,
          input: null,
          output: { text: compactOutput },
          error: null,
          attributes: {
            eventType: "codex.context.compaction",
          },
        },
        {
          id: "span-2",
          parentSpanId: null,
          spanIndex: 1,
          kind: "tool",
          name: "exec",
          status: "completed",
          startedAt: "2026-08-10T00:00:01Z",
          endedAt: "2026-08-10T00:00:01Z",
          callId: "call-1",
          input: null,
          output: { text: toolOutput },
          error: null,
          attributes: {
            eventType: "codex.tool.result",
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        createElement(TurnAccordion, {
          sessionKey: "codex:compact",
          turns: [turn],
          loading: false,
          matchedTurnId: null,
          matchedMessageIndex: null,
          showTools: true,
          query: "",
          language: "en",
          onLoadTurn: async () => detail,
        }),
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".turn-card-summary")
        ?.click();
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector(".msg-tool-payload pre"),
      ).not.toBeNull();
    });

    const payloads = [
      ...container.querySelectorAll<HTMLElement>(".msg-tool-payload"),
    ];

    const compactPayload = payloads.find((payload) =>
      payload
        .querySelector("pre")
        ?.textContent?.startsWith("compact-payload:"),
    );

    const preview =
      compactPayload?.querySelector("pre")?.textContent ?? "";

    expect(preview.length).toBeLessThan(compactOutput.length);
    expect(preview).toContain("...(truncated)");

    const expand =
      compactPayload?.querySelector<HTMLButtonElement>("button");

    expect(expand?.textContent).toContain("Show full detail");
    expect(expand).toBeDefined();

    await act(async () => {
      expand?.click();
    });

    expect(
      compactPayload?.querySelector("pre")?.textContent,
    ).toBe(compactOutput);

    const toolPayload = payloads.find((payload) =>
      payload
        .querySelector("pre")
        ?.textContent?.startsWith("tool-payload:"),
    );

    expect(
      toolPayload?.querySelector("pre")?.textContent,
    ).toBe(toolOutput);

    expect(toolPayload?.querySelector("button")).toBeNull();
  });
});

describe("TurnAccordion message parity", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalSessionSearch: unknown;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    originalSessionSearch = Reflect.get(window, "sessionSearch");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalSessionSearch === undefined) {
      Reflect.deleteProperty(window, "sessionSearch");
    } else {
      Reflect.set(window, "sessionSearch", originalSessionSearch);
    }
    vi.restoreAllMocks();
  });

  it("renders a Turn image attachment and opens its preview", async () => {
    const turn = createTurn("turn-attachment", 0);
    const detail = createTurnDetail(turn);
    detail.messages[0].attachments = [
      {
        id: "attachment-1",
        fileName: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 2_048,
        previewKind: "image",
        status: "available",
      },
    ];
    const previewAttachment = vi.fn(async () => ({
      kind: "image" as const,
      data: "data:image/png;base64,AAAA",
    }));
    Reflect.set(window, "sessionSearch", { previewAttachment });

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:attachment"
          turns={[turn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          language="en"
          onLoadTurn={async () => detail}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLButtonElement>(".message-attachments button")).not.toBeNull();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".message-attachments button")?.click();
      await Promise.resolve();
    });

    expect(previewAttachment).toHaveBeenCalledWith("codex:attachment", "attachment-1");
    const image = container.querySelector<HTMLImageElement>(".attachment-preview-dialog img");
    expect(image?.src).toBe("data:image/png;base64,AAAA");
    expect(image?.alt).toBe("screenshot.png");
  });

  it("handles a rejected attachment preview without an unhandled rejection", async () => {
    const turn = createTurn("turn-broken-attachment", 0);
    const detail = createTurnDetail(turn);
    detail.messages[0].attachments = [
      {
        id: "attachment-broken",
        fileName: "broken.png",
        mimeType: "image/png",
        previewKind: "image",
        status: "available",
      },
    ];
    const previewAttachment = vi.fn(() => Promise.reject(new Error("preview failed")));
    const unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);
    Reflect.set(window, "sessionSearch", { previewAttachment });

    try {
      await act(async () => {
        root.render(
          <TurnAccordion
            sessionKey="codex:broken-attachment"
            turns={[turn]}
            loading={false}
            matchedTurnId={null}
            matchedMessageIndex={null}
            showTools
            query=""
            language="en"
            onLoadTurn={async () => detail}
          />,
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
      });
      await vi.waitFor(() => {
        expect(container.querySelector<HTMLButtonElement>(".message-attachments button")).not.toBeNull();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".message-attachments button")?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(previewAttachment).toHaveBeenCalledOnce();
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(container.querySelector(".attachment-preview-dialog")).toBeNull();
    } finally {
      window.removeEventListener("unhandledrejection", unhandledRejection);
    }
  });

  it("filters Turn messages by user and assistant role", async () => {
    const turn = createTurn("turn-role", 0, "visible user", "visible assistant");
    const detail = createTurnDetail(turn);
    const onLoadTurn = vi.fn(async () => detail);

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:roles"
          turns={[turn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          roleFilter="user"
          query=""
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg.user")).toHaveLength(1);
    });
    expect(container.querySelector(".msg.assistant")).toBeNull();
    expect(container.querySelector(".turn-card-summary small")).toBeNull();
    expect(container.querySelector(".turn-card-summary strong")?.textContent).toContain("visible user");

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:roles"
          turns={[turn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          roleFilter="assistant"
          query=""
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
    });

    expect(container.querySelector(".msg.user")).toBeNull();
    expect(container.querySelectorAll(".msg.assistant")).toHaveLength(1);
    expect(container.querySelector(".turn-card-summary strong")?.textContent).toContain("visible assistant");
  });
});

describe("TurnAccordion in-conversation find", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    scrollIntoView.mockReset();
    vi.restoreAllMocks();
  });

  it("loads Turn details sequentially and navigates to the active match", async () => {
    const firstTurn = createTurn("turn-find-1", 0);
    const secondTurn = createTurn("turn-find-2", 1);
    const first = deferred<SessionTurnDetail | null>();
    const second = deferred<SessionTurnDetail | null>();
    const onLoadTurn = vi.fn((turnId: string) => turnId === firstTurn.id ? first.promise : second.promise);
    const onFindMatchCountChange = vi.fn();

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:find"
          turns={[firstTurn, secondTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          activeFindMatchIndex={0}
          language="en"
          onLoadTurn={onLoadTurn}
          onFindMatchCountChange={onFindMatchCountChange}
        />,
      );
    });

    await vi.waitFor(() => expect(onLoadTurn).toHaveBeenCalledTimes(1));
    expect(onLoadTurn).toHaveBeenNthCalledWith(1, firstTurn.id);

    await act(async () => {
      first.resolve(createTurnDetail(firstTurn, "first needle", "not here"));
      await first.promise;
    });
    await vi.waitFor(() => expect(onLoadTurn).toHaveBeenCalledTimes(2));
    expect(onLoadTurn).toHaveBeenNthCalledWith(2, secondTurn.id);

    await act(async () => {
      second.resolve(createTurnDetail(secondTurn, "second needle", "also not here"));
      await second.promise;
    });
    await vi.waitFor(() => {
      expect(onFindMatchCountChange).toHaveBeenLastCalledWith(2);
    });

    const firstMatch = container.querySelector<HTMLElement>(
      '[data-find-key="turn-find-1:message:0"]',
    );
    expect(firstMatch?.querySelector(".msg")?.classList.contains("match-target")).toBe(true);
    expect(scrollIntoView.mock.instances).toContain(firstMatch);
  });

  it("stops queued loads when the find query is cleared", async () => {
    const firstTurn = createTurn("turn-cancel-1", 0);
    const secondTurn = createTurn("turn-cancel-2", 1);
    const first = deferred<SessionTurnDetail | null>();
    const onLoadTurn = vi.fn(() => first.promise);

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:cancel-find"
          turns={[firstTurn, secondTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
    });
    await vi.waitFor(() => expect(onLoadTurn).toHaveBeenCalledTimes(1));

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:cancel-find"
          turns={[firstTurn, secondTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery=""
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
    });
    await act(async () => {
      first.resolve(createTurnDetail(firstTurn, "needle", ""));
      await first.promise;
      await Promise.resolve();
    });

    expect(onLoadTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale Turn response after switching sessions", async () => {
    const oldTurn = createTurn("shared-turn", 0, "old preview", "");
    const newTurn = createTurn("shared-turn", 0, "new preview", "");
    const oldRequest = deferred<SessionTurnDetail | null>();
    const oldLoadTurn = vi.fn(() => oldRequest.promise);
    const newDetail = createTurnDetail(newTurn, "new needle", "new assistant");
    const newLoadTurn = vi.fn(async () => newDetail);

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:old-session"
          turns={[oldTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          activeFindMatchIndex={0}
          language="en"
          onLoadTurn={oldLoadTurn}
        />,
      );
    });
    await vi.waitFor(() => expect(oldLoadTurn).toHaveBeenCalledOnce());

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:new-session"
          turns={[newTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          activeFindMatchIndex={0}
          language="en"
          onLoadTurn={newLoadTurn}
        />,
      );
    });
    await vi.waitFor(() => expect(newLoadTurn).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("new needle");
    });

    await act(async () => {
      oldRequest.resolve(createTurnDetail(oldTurn, "old needle", "old assistant"));
      await oldRequest.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("new needle");
    expect(container.textContent).not.toContain("old needle");
  });

  it("does not reuse a loaded Turn with the same id after switching sessions", async () => {
    const oldTurn = createTurn("shared-loaded-turn", 0, "old preview", "");
    const newTurn = createTurn("shared-loaded-turn", 0, "new preview", "");
    const oldLoadTurn = vi.fn(async () => createTurnDetail(oldTurn, "old needle", ""));
    const newLoadTurn = vi.fn(async () => createTurnDetail(newTurn, "new needle", ""));

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:loaded-old-session"
          turns={[oldTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          activeFindMatchIndex={0}
          language="en"
          onLoadTurn={oldLoadTurn}
        />,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("old needle");
    });

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:loaded-new-session"
          turns={[newTurn]}
          loading={false}
          matchedTurnId={null}
          matchedMessageIndex={null}
          showTools
          query=""
          findQuery="needle"
          activeFindMatchIndex={0}
          language="en"
          onLoadTurn={newLoadTurn}
        />,
      );
    });

    await vi.waitFor(() => expect(newLoadTurn).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("new needle");
    });
    expect(container.textContent).not.toContain("old needle");
  });
});
