// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenVikingDiagnosticsSnapshot } from "../../../../core/openviking-memory";
import { OpenVikingRuntimeMonitor } from "./openviking-runtime-monitor";

const snapshot: OpenVikingDiagnosticsSnapshot = {
  capturedAt: "2026-09-03T03:00:00.000Z",
  runtime: {
    status: { state: "running", version: "0.4.11-r6", port: 50122 },
    health: "healthy",
    pid: 101,
    port: 50122,
    events: [],
  },
  model: { model: "BAAI/bge-small-zh-v1.5", installed: true },
  workspaces: [{
    id: "workspace-1",
    userId: "workspace_user",
    rootPath: "/tmp/project",
    identity: "project",
    displayName: "project",
    managed: true,
    createdAt: "2026-09-01T03:00:00.000Z",
    updatedAt: "2026-09-03T03:00:00.000Z",
  }],
  control: {
    recentCommits: [{
      taskId: "task-2",
      workspaceId: "workspace-1",
      sessionId: "session-2",
      agent: "codex",
      trigger: "explicit-remember",
      state: "completed",
      sourceTurnIds: ["turn-2"],
      tokenEstimate: 80,
      memoryDiffUri: "viking://user/workspace_user/sessions/session-2/history/archive-2/memory_diff.json",
      memoriesExtracted: { memory_edit: 1, memory_write: 1 },
      startedAt: "2026-09-03T02:59:20.000Z",
      completedAt: "2026-09-03T02:59:30.000Z",
      updatedAt: "2026-09-03T02:59:30.000Z",
    }, {
      taskId: "task-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agent: "codex",
      trigger: "session-end",
      state: "failed",
      sourceTurnIds: ["turn-1"],
      tokenEstimate: 42,
      error: "VLM response was invalid",
      startedAt: "2026-09-03T02:59:00.000Z",
      updatedAt: "2026-09-03T02:59:10.000Z",
    }],
    recentEvents: [{
      id: "event-1",
      workspaceId: "workspace-1",
      phase: "search",
      status: "completed",
      sessionId: "session-1",
      startedAt: "2026-09-03T02:58:00.000Z",
      completedAt: "2026-09-03T02:58:00.040Z",
      durationMs: 40,
      details: {
        source: "memory-page",
        userQuery: "How does the release work?",
        contextualQuery: "release workflow and previous decision",
        searchedScopes: ["workspace-1"],
        searchedTypes: ["preferences", "events"],
        targetUri: "viking://user/memories",
        limit: 20,
        candidateCount: 3,
        returnedCount: 1,
      },
    }],
    recentRecallTraces: [{
      id: "trace-1",
      workspaceId: "workspace-1",
      agent: "codex",
      query: "How does the release work?",
      contextualQuery: "release workflow and previous decision",
      searchedScopes: ["workspace-1"],
      searchedTypes: ["preferences"],
      candidates: [{
        uri: "viking://user/memories/preferences/release.md",
        score: 0.91,
        decision: "injected",
        reason: "selected",
        memoryType: "preferences",
        authority: "model",
        lifecycle: "active",
        evidenceStatus: "verified",
        locked: false,
      }, {
        uri: "viking://user/memories/context/old.md",
        decision: "filtered",
        reason: "superseded",
        memoryType: "context",
        authority: "model",
        lifecycle: "superseded",
        evidenceStatus: "verified",
        locked: false,
      }, {
        uri: "viking://user/memories/context/large.md",
        decision: "budget",
        reason: "token-budget",
        memoryType: "context",
        authority: "model",
        lifecycle: "active",
        evidenceStatus: "legacy",
        locked: false,
      }],
      injectedUris: ["viking://user/memories/preferences/release.md"],
      injectedTokenCount: 128,
      durationMs: 55,
      createdAt: "2026-09-03T02:58:00.000Z",
    }],
  },
};

describe("OpenVikingRuntimeMonitor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        getOpenVikingDiagnostics: vi.fn(async () => snapshot),
        readOpenVikingCommitChanges: vi.fn(async () => [{
          kind: "add",
          uri: "viking://user/memories/preferences/editor.md",
          memoryType: "preferences",
          after: "Prefer concise diffs.",
        }, {
          kind: "update",
          uri: "viking://user/memories/events/release.md",
          memoryType: "events",
          before: "Release weekly.",
          after: "Release daily.",
        }]),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("visualizes recent recall outcomes and opens candidate decisions", async () => {
    await act(async () => root.render(<OpenVikingRuntimeMonitor language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Recall attempts"));

    const overview = container.querySelector(".openviking-recall-overview");
    expect(overview?.textContent).toContain("Injected1");
    expect(overview?.textContent).toContain("Filtered 1");
    expect(overview?.textContent).toContain("Over budget 1");

    const recallRow = [...container.querySelectorAll<HTMLButtonElement>(".openviking-control-row")]
      .find((button) => button.textContent?.includes("How does the release work?"));
    expect(recallRow).toBeDefined();
    await act(async () => recallRow?.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Recall detail");
    expect(dialog?.textContent).toContain("Memory injected");
    expect(dialog?.textContent).toContain("release workflow and previous decision");
    expect(dialog?.textContent).toContain("token-budget");
    expect(dialog?.textContent).toContain("0.9100");
  });

  it("keeps healthy directory tracking compact until the user expands it", async () => {
    await act(async () => root.render(<OpenVikingRuntimeMonitor language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Directory tracking is healthy"));

    const summary = container.querySelector<HTMLButtonElement>(".openviking-directory-summary");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("/tmp/project");

    await act(async () => summary?.click());
    expect(summary?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("/tmp/project");
    expect(container.textContent).toContain("Historical sessions are not imported");
  });

  it("shows the persisted failure reason for a failed extraction", async () => {
    await act(async () => root.render(<OpenVikingRuntimeMonitor language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Extraction runs"));

    const commitRow = [...container.querySelectorAll<HTMLButtonElement>(".openviking-control-row")]
      .find((button) => button.textContent?.includes("Session end"));
    await act(async () => commitRow?.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Extraction detail");
    expect(dialog?.textContent).toContain("Failure reason");
    expect(dialog?.textContent).toContain("VLM response was invalid");
    expect(dialog?.textContent).toContain("session-1");
  });

  it("loads and renders the concrete Memory Diff for a completed extraction", async () => {
    await act(async () => root.render(<OpenVikingRuntimeMonitor language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Extraction runs"));

    const commitRow = [...container.querySelectorAll<HTMLButtonElement>(".openviking-control-row")]
      .find((button) => button.textContent?.includes("Explicit remember"));
    await act(async () => commitRow?.click());

    await vi.waitFor(() => expect(document.body.textContent).toContain("Concrete memory changes"));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Written content");
    expect(dialog?.textContent).toContain("Prefer concise diffs.");
    expect(dialog?.textContent).toContain("Before");
    expect(dialog?.textContent).toContain("Release weekly.");
    expect(dialog?.textContent).toContain("After");
    expect(dialog?.textContent).toContain("Release daily.");
    expect(window.sessionSearch.readOpenVikingCommitChanges).toHaveBeenCalledWith(
      "workspace-1",
      "viking://user/workspace_user/sessions/session-2/history/archive-2/memory_diff.json",
    );
  });

  it("explains a memory search with its question, range and result counts", async () => {
    await act(async () => root.render(<OpenVikingRuntimeMonitor language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Pipeline stages"));

    const searchRow = [...container.querySelectorAll<HTMLButtonElement>(".openviking-control-row")]
      .find((button) => button.textContent?.includes("Memory search"));
    await act(async () => searchRow?.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("User question");
    expect(dialog?.textContent).toContain("How does the release work?");
    expect(dialog?.textContent).toContain("Actual search query");
    expect(dialog?.textContent).toContain("release workflow and previous decision");
    expect(dialog?.textContent).toContain("Directory: workspace-1");
    expect(dialog?.textContent).toContain("Type: preferences");
    expect(dialog?.textContent).toContain("Candidates");
    expect(dialog?.textContent).toContain("Returned");
  });
});
