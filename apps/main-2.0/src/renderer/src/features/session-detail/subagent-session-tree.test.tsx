// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionFamily, SubagentSessionNode } from "../../../../core/session-family";
import { SubagentSessionTree } from "./subagent-session-tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function child(sessionKey: string, title: string, originTurnIndex: number | null): SubagentSessionNode {
  return {
    sessionKey,
    rawId: sessionKey,
    title,
    source: "codex-cli",
    environmentId: "local",
    environmentLabel: "Local",
    messageCount: 4,
    lastActivityAt: Date.parse("2026-08-12T09:10:00.000Z"),
    aiSummary: null,
    originTurnIndex,
    children: [],
  };
}

function render(family: SessionFamily, onOpen = vi.fn()): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SubagentSessionTree family={family} language="zh" onOpen={onOpen} />));
  return host;
}

describe("SubagentSessionTree", () => {
  it("names the parent Turn that started this Session in one line", () => {
    const view = render({
      parent: { ...child("codex:parent", "Parent", null), messageCount: 10 },
      parentOriginTurnIndex: 62,
      children: [],
      truncated: false,
    });

    expect(view.textContent).toContain("父会话 · 由第 63 轮发起");
    expect(view.textContent).toContain("Parent");
  });

  it("keeps subagent Sessions folded behind their count until the reader opens them", () => {
    const onOpen = vi.fn();
    const view = render({
      parent: null,
      parentOriginTurnIndex: null,
      children: [child("codex:a", "Review the build", 2), child("codex:b", "Audit the docs", null)],
      truncated: false,
    }, onOpen);

    const toggle = view.querySelector<HTMLButtonElement>("button.subagent-tree-head")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("子 Agent 会话");
    expect(toggle.textContent).toContain("2");
    expect(view.textContent).not.toContain("Review the build");

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = [...view.querySelectorAll<HTMLButtonElement>(".subagent-session-card")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Review the build", "Audit the docs"]);
    expect(rows[0].textContent).toContain("第 3 轮");
    expect(rows[0].textContent).toContain("4 条");

    act(() => rows[1].click());
    expect(onOpen).toHaveBeenCalledWith("codex:b");
  });
});
