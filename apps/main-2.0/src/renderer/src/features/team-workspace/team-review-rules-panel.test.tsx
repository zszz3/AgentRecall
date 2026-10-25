// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { TeamReviewRulesPanel } from "./team-review-rules-panel";

const repository = "https://github.com/example/assets", commit = "1".repeat(40);
const selection = { team: { id: "example", name: "Example", repository }, enabled: true, busy: false };
let container: HTMLDivElement, root: Root;
const openExternalLink = vi.fn(async () => undefined);
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.stubGlobal("sessionSearch", { openExternalLink }); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); openExternalLink.mockReset(); });
const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name)!;
const input = (label: string, value: string) => {
  const element = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

it("previews generated OWNERS.json and CODEOWNERS before publishing, and offers the pull request when the rules protect themselves", async () => {
  let rules: { resources: string[]; owners: string[] }[] | null = null;
  const request = vi.fn(async (value: TeamRequest): Promise<TeamReply> => {
    if (value.action === "review-rules") return { ok: true, data: { kind: "review-rules", value: { commit, rules: rules ? { schemaVersion: 1, rules } : null } } };
    if (value.action === "configuration-preview" && value.change.kind === "reviewRules") {
      const protectsItself = rules?.some(rule => rule.resources.includes("reviewRules"));
      return { ok: true, data: { kind: "configuration-preview", value: { token: "token", expiresAt: Date.now() + 60_000, repository, revision: commit, branch: "main", kind: "reviewRules", operation: value.change.operation, name: "审核规则", files: [{ path: "OWNERS.json", before: null, after: JSON.stringify({ schemaVersion: 1, rules: value.change.value.rules }) }, { path: ".github/CODEOWNERS", before: null, after: "/agentrecall.json @acme/platform\n" }], ...(protectsItself ? { review: { branch: "agentrecall/review/abc", owners: ["@acme/platform"] } } : {}) } } };
    }
    if (value.action === "configuration-publish") {
      if (rules) return { ok: true, data: { kind: "configuration-published", value: { repository, commit: "3".repeat(40), cacheUpdated: false, cleanupRequired: false, review: { branch: "agentrecall/review/abc", owners: ["@acme/platform"], base: "main", url: `${repository}/compare/main...agentrecall/review/abc?expand=1` } } } };
      rules = [{ resources: ["mcp", "reviewRules"], owners: ["@acme/platform"] }];
      return { ok: true, data: { kind: "configuration-published", value: { repository, commit: "2".repeat(40), cacheUpdated: true, cleanupRequired: false } } };
    }
    if (value.action === "configuration-discard") return { ok: true, data: { kind: "cancelled" } };
    throw new Error(`Unexpected ${value.action}`);
  });
  await act(async () => root.render(<TeamReviewRulesPanel selection={selection} language="zh" api={{ request }} />));
  expect(container.textContent).toContain("还没有审核规则");
  await act(async () => button("设置审核规则").click());
  await act(async () => input("规则 1 的资源", "mcp reviewRules"));
  await act(async () => input("规则 1 的审核人", "acme/platform"));
  await act(async () => button("预览变更").click());
  expect(request).toHaveBeenCalledWith({ action: "configuration-preview", scope: { teamId: "example", repository }, revision: commit, change: { kind: "reviewRules", operation: "create", value: { id: "review-rules", name: "审核规则", rules: [{ resources: ["mcp", "reviewRules"], owners: ["@acme/platform"] }] } } });
  expect(container.textContent).toContain(".github/CODEOWNERS");
  await act(async () => button("发布到团队").click());
  expect(container.textContent).toContain("审核规则已发布。");
  expect(container.querySelector(".team-review-table")?.textContent).toContain("全部 MCP、全部审核规则@acme/platform");

  await act(async () => button("编辑规则").click());
  await act(async () => input("规则 1 的资源", "mcp skills:review reviewRules"));
  await act(async () => button("预览变更").click());
  expect(container.textContent).toContain("此修改将提交给 @acme/platform 审核");
  await act(async () => button("提交审核").click());
  expect(container.textContent).toContain("已提交审核，等待 @acme/platform 批准");
  await act(async () => button("打开 Pull Request").click());
  expect(openExternalLink).toHaveBeenCalledWith(`${repository}/compare/main...agentrecall/review/abc?expand=1`);
});
