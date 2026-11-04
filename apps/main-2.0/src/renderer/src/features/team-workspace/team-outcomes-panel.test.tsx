// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OutcomeChange, TeamOutcome } from "@agentrecall/workspace-core";
import type { TeamCatalog, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { TeamSharedSession } from "../../../../shared/team-sessions";
import { TeamOutcomesPanel } from "./team-outcomes-panel";

const repository = "https://github.com/example/assets";
const team = { id: "example", name: "Example", repository };
const selection = { team, enabled: true, busy: false };
const older: TeamOutcome = { id: "old-review", name: "Earlier review", summary: "", source: { kind: "manual" }, sessions: [], tags: [], createdAt: 1_000, path: "outcomes/old-review.md", content: "# Earlier\n", digest: "a".repeat(64) };
const newer: TeamOutcome = { id: "release-review", name: "Release review", summary: "Two blockers.", source: { kind: "workflow-run", workflow: "PR review" }, sessions: [{ id: 42, title: "Review chat" }], tags: ["release"], createdAt: 2_000, path: "outcomes/release-review.md", content: "# Release review\nFix migrations.", digest: "b".repeat(64) };
const catalog = (outcomes: TeamOutcome[]): TeamCatalog => ({ projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: "1".repeat(40), skills: [], documents: [], workConfigs: [], organization: [], agentRoles: [], outcomes, configuration: { instructions: [], environment: [], mcpServers: [] } } });
const shared: TeamSharedSession[] = [{ id: 42, title: "Review chat", author: "ana", createdAt: "2026-01-01", bytes: 10, digest: "d", canWithdraw: false }, { id: -3, title: "Not uploaded", author: "me", createdAt: "2026-01-01", bytes: 10, digest: "e", canWithdraw: false, local: true }];
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
const button = (label: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label)); if (!value) throw new Error("Missing button " + label); return value; };
const api = (outcomes: TeamOutcome[]) => ({ request: vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "catalog" ? { ok: true, data: { kind: "catalog", value: catalog(outcomes) } }
  : input.action === "session-list" ? { ok: true, data: { kind: "session-list", value: { items: shared, page: 1, hasMore: false } } } : { ok: true, data: { kind: "cancelled" } }) });
const type = (selector: string, value: string) => {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

it("lists newest outcomes first and shows the record with its linked shared sessions", async () => {
  await act(async () => root.render(<TeamOutcomesPanel language="zh" selection={selection} refreshKey={0} api={api([older, newer])} onStage={vi.fn()} />));
  const rows = [...container.querySelectorAll(".team-resource-row strong")].map(item => item.textContent);
  expect(rows).toEqual(["Release review", "Earlier review"]);
  expect(container.querySelector(".team-resource-row small")?.textContent).toContain("Workflow“PR review”");
  await act(async () => button("Release review").click());
  const reader = container.querySelector('[aria-label="成果详情"]')!;
  expect(reader.textContent).toContain("Two blockers.");
  expect(reader.textContent).toContain("关联的共享会话：Review chat");
  expect(reader.textContent).toContain("Fix migrations.");
});

it("records a hand-written outcome with uploaded shared sessions and stages it for Push", async () => {
  const onStage = vi.fn(async (_change: OutcomeChange) => undefined);
  await act(async () => root.render(<TeamOutcomesPanel language="zh" selection={selection} refreshKey={0} api={api([])} onStage={onStage} />));
  expect(container.textContent).toContain("还没有运行成果");
  await act(async () => button("沉淀成果").click());
  expect(container.querySelector("dialog select")).toBeNull();
  expect(container.querySelector("dialog")!.textContent).not.toContain("Not uploaded");
  await act(async () => {
    type("dialog input[maxlength='200']", "PR review notes");
    type("dialog textarea[required]", "- Verdict: Needs changes");
  });
  const session = [...container.querySelectorAll<HTMLInputElement>('dialog input[type="checkbox"]')][0]!;
  await act(async () => session.click());
  await act(async () => button("保存到共享空间").closest("form")!.requestSubmit());
  const change = onStage.mock.calls[0]![0];
  expect(change).toMatchObject({ kind: "outcomes", operation: "create", value: { name: "PR review notes", source: { kind: "manual" }, sessions: [{ id: 42, title: "Review chat" }] } });
  expect(change.value.content).toContain("- Verdict: Needs changes");
  expect(container.querySelector("dialog")).toBeNull();
});
