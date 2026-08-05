// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

const turn: SessionTurnSummary = {
  id: "turn-1",
  turnIndex: 0,
  sourceMessageIndex: 0,
  sourceTurnId: "source-turn-1",
  synthetic: false,
  status: "completed",
  startedAt: "2026-08-04T03:00:00.000Z",
  endedAt: "2026-08-04T03:00:01.000Z",
  userPreview: "delegate",
  assistantPreview: "done",
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  errorCount: 0,
  toolNames: [],
  messageCount: 0,
  spanCount: 1,
};

const detail: SessionTurnDetail = {
  ...turn,
  messages: [],
  spans: [{
    id: "span-1",
    parentSpanId: null,
    spanIndex: 0,
    kind: "event",
    name: "Agent message",
    status: "completed",
    startedAt: "2026-08-04T03:00:00.500Z",
    endedAt: "2026-08-04T03:00:00.500Z",
    callId: null,
    input: null,
    output: {
      message: {
        type: "agent_message",
        content: [{ type: "encrypted_content", encrypted_content: "ciphertext" }],
      },
      direction: "incoming",
      triggerTurn: false,
      messageType: "final_answer",
    },
    error: null,
    attributes: {
      eventType: "codex.collaboration.message",
      collaboration: {
        author: "/root/worker",
        recipient: "/root",
        direction: "incoming",
        triggerTurn: false,
        messageType: "final_answer",
      },
    },
  }],
};

describe("TurnAccordion collaboration messages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Reflect.set(HTMLElement.prototype, "scrollIntoView", vi.fn());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps Agent metadata in JSON while showing only the route outside it", async () => {
    await act(async () => {
      root.render(createElement(TurnAccordion, {
        sessionKey: "codex:parent",
        turns: [turn],
        loading: false,
        matchedTurnId: null,
        showTools: true,
        query: "",
        language: "zh",
        onLoadTurn: async () => detail,
      }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
      await Promise.resolve();
    });

    const body = container.querySelector(".msg-tool-body");
    expect(container.querySelector(".msg-head strong")?.textContent).toBe("Agent message");
    expect(body?.textContent).toContain("/root/worker → /root");
    expect(body?.textContent).toContain('"triggerTurn": false');
    expect(body?.textContent).toContain('"encrypted_content": "ciphertext"');
    expect(body?.textContent).not.toContain("不触发新 turn");
    expect(body?.textContent).not.toContain("消息正文已加密");
    expect(container.querySelector(".lucide-bot-message-square")).not.toBeNull();
  });

  it("uses a larger Agent icon for all collaboration spans while retaining the tool icon elsewhere", async () => {
    const spans: SessionTurnDetail["spans"] = [
      detail.spans[0],
      {
        ...detail.spans[0],
        id: "span-activity",
        spanIndex: 1,
        name: "subagent · started",
        output: null,
        attributes: {
          eventType: "codex.collaboration.activity",
          collaboration: { kind: "started", agentPath: "/root/worker" },
        },
      },
      {
        ...detail.spans[0],
        id: "span-collaboration-tool",
        spanIndex: 2,
        name: "agent · spawn_agent",
        output: null,
        attributes: {
          eventType: "codex.collaboration.tool",
          collaboration: { tool: "spawn_agent" },
        },
      },
      {
        ...detail.spans[0],
        id: "span-direct-collaboration-tool",
        spanIndex: 3,
        name: "collaboration.wait_agent",
        output: null,
        attributes: { eventType: "codex.function_call" },
      },
      {
        ...detail.spans[0],
        id: "span-ordinary-tool",
        spanIndex: 4,
        name: "exec_command",
        output: null,
        attributes: { eventType: "codex.function_call" },
      },
    ];
    await act(async () => {
      root.render(createElement(TurnAccordion, {
        sessionKey: "codex:parent",
        turns: [{ ...turn, spanCount: spans.length }],
        loading: false,
        matchedTurnId: null,
        showTools: true,
        query: "",
        language: "zh",
        onLoadTurn: async () => ({ ...detail, spanCount: spans.length, spans }),
      }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".msg-tool-summary .lucide-bot-message-square")).toHaveLength(4);
    expect(container.querySelectorAll(".msg-tool-summary .lucide-wrench")).toHaveLength(1);
    expect(container.querySelector(".msg-tool-summary .lucide-bot-message-square")?.getAttribute("width")).toBe("13");
    expect(container.querySelector(".msg-tool-summary .lucide-wrench")?.getAttribute("width")).toBe("11");
  });
});
