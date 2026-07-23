import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionFamily } from "../../../../core/session-family";
import { SubagentSessionTree } from "./subagent-session-tree";

const FAMILY: SessionFamily = {
  parent: {
    sessionKey: "codex:parent",
    rawId: "parent",
    title: "父会话标题",
    source: "codex-cli",
    environmentId: "local",
    environmentLabel: "Local",
    messageCount: 8,
    lastActivityAt: 1,
    aiSummary: null,
  },
  children: [{
    sessionKey: "codex:child",
    rawId: "child",
    title: "一级任务",
    source: "codex-cli",
    environmentId: "local",
    environmentLabel: "Local",
    messageCount: 4,
    lastActivityAt: 2,
    aiSummary: "分析登录问题",
    children: [{
      sessionKey: "codex:grandchild",
      rawId: "grandchild",
      title: "二级任务",
      source: "codex-cli",
      environmentId: "ssh-dev",
      environmentLabel: "SSH dev",
      messageCount: 2,
      lastActivityAt: 3,
      aiSummary: null,
      children: [],
    }],
  }],
  truncated: true,
};

describe("SubagentSessionTree", () => {
  it("renders nothing when the session has no family relationships", () => {
    const html = renderToStaticMarkup(createElement(SubagentSessionTree, {
      family: { parent: null, children: [], truncated: false },
      language: "zh",
      onOpen: () => undefined,
    }));

    expect(html).toBe("");
  });

  it("shows the parent and direct children while keeping deeper levels collapsed", () => {
    const html = renderToStaticMarkup(createElement(SubagentSessionTree, {
      family: FAMILY,
      language: "zh",
      onOpen: () => undefined,
    }));

    expect(html).toContain("父会话");
    expect(html).toContain("父会话标题");
    expect(html).toContain("子 Agent 会话");
    expect(html).toContain("一级任务");
    expect(html).toContain("分析登录问题");
    expect(html).not.toContain("二级任务");
    expect(html).toContain("展开一级任务的子会话");
  });

  it("shows a bounded-data notice when the family was truncated", () => {
    const html = renderToStaticMarkup(createElement(SubagentSessionTree, {
      family: FAMILY,
      language: "zh",
      onOpen: () => undefined,
    }));

    expect(html).toContain("还有更多子会话未展示");
  });
});
