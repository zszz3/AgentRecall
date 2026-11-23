// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstructionFile } from "../../../../shared/ipc/instructions";
import { InstructionsPage } from "./instructions-page";

const file = (path: string, extra: Partial<InstructionFile>): InstructionFile => ({
  path, name: path.split("/").at(-1)!, scope: "project", agents: [], project: null, aliases: [], size: 12, modifiedAt: "2026-11-20T08:00:00.000Z", ...extra,
});

const userFile = file("/home/.claude/CLAUDE.md", { scope: "user", agents: ["Claude Code"], size: 0 });
const projectFile = file("/work/repo/AGENTS.md", { project: "/work/repo", aliases: ["/work/repo/CLAUDE.md"] });

const teams = (instructions: unknown[]) => ({
  request: vi.fn(async (request: { action: string }) => request.action === "snapshot"
    ? { ok: true, data: { kind: "snapshot", value: { config: { schemaVersion: 4, teamEnabled: true, defaultTeamId: "t1", teams: [{ id: "t1", name: "Core", repository: "acme/core" }], projects: [], directories: [] }, busy: false, directories: [] } } }
    : { ok: true, data: { kind: "catalog", value: { projectId: "p", root: null, notice: null, installed: {}, assets: { configuration: { instructions } } } } }),
});

describe("InstructionsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function install(api: Record<string, unknown>) {
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
  }
  const render = (props: Record<string, unknown> = {}) => act(async () => root.render(createElement(InstructionsPage, { language: "en", teamApi: teams([]), ...props } as never)));
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const item = (title: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>(".catalog-item")].find((entry) => entry.querySelector(".catalog-item-title")?.textContent === title);
    if (!found) throw new Error(`Missing item ${title}`);
    return found;
  };
  const detail = () => container.querySelector<HTMLElement>(".catalog-detail")!;

  it("lists the agents', projects' and team's instructions and shows the selected one without an editor", async () => {
    const readInstructionFile = vi.fn(async (path: string) => path === projectFile.path ? "# Repo rules\n\nRun the tests." : "");
    install({ listInstructionFiles: vi.fn(async () => [userFile, projectFile]), readInstructionFile });
    const onOpenTeamSpace = vi.fn();
    await render({ onOpenTeamSpace, teamApi: teams([{ id: "rules", name: "Team rules", content: "Use pnpm.", targets: ["codex", "claude"] }]) });

    expect([...container.querySelectorAll(".catalog-group h3 span")].map((heading) => heading.textContent)).toEqual(["Agents", "repo", "Team · Core"]);
    expect(container.querySelector(".catalog-head-meta")?.textContent).toBe("2 files · 1 projects · 1 team instructions");
    expect(container.querySelector("textarea")).toBeNull();
    expect(item("Claude Code").getAttribute("aria-current")).toBe("true");
    expect(detail().textContent).toContain("This file is empty.");

    await act(async () => item("AGENTS.md").click());
    expect(readInstructionFile).toHaveBeenLastCalledWith("/work/repo/AGENTS.md");
    expect(item("AGENTS.md").querySelector(".catalog-item-meta")?.textContent).toBe("Also CLAUDE.md");
    expect(detail().querySelector("h3")?.textContent).toBe("AGENTS.md");
    expect(detail().textContent).toContain("Run the tests.");
    expect(detail().textContent).toContain("/work/repo/CLAUDE.md");

    await act(async () => item("Team rules").click());
    expect(detail().textContent).toContain("Use pnpm.");
    expect(detail().textContent).toContain("AGENTS.md、CLAUDE.md");
    await act(async () => button("Edit in team space").click());
    expect(onOpenTeamSpace).toHaveBeenCalledOnce();
  });

  it("opens the file in its editor, reveals it and shows why an action failed", async () => {
    const openInstructionFile = vi.fn(async () => undefined);
    const revealInstructionFile = vi.fn(async () => { throw new Error("Error invoking remote method 'instructions:reveal': Error: AGENTS.md is not one of the instruction files any more."); });
    install({ listInstructionFiles: vi.fn(async () => [projectFile]), readInstructionFile: vi.fn(async () => "rules"), openInstructionFile, revealInstructionFile });
    await render();

    await act(async () => button("Open in editor").click());
    expect(openInstructionFile).toHaveBeenCalledWith("/work/repo/AGENTS.md");
    await act(async () => button("Show in folder").click());
    expect(detail().querySelector("[role=alert]")?.textContent).toBe("AGENTS.md is not one of the instruction files any more.");
  });

  it("filters the list and says what it looks for when nothing is found", async () => {
    const listInstructionFiles = vi.fn(async () => [userFile, projectFile]);
    install({ listInstructionFiles, readInstructionFile: vi.fn(async () => "") });
    await render();

    const search = container.querySelector<HTMLInputElement>(".catalog-search input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "repo");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll(".catalog-item-title")].map((title) => title.textContent)).toEqual(["AGENTS.md"]);

    listInstructionFiles.mockResolvedValue([]);
    await act(async () => button("Look again").click());
    expect(container.textContent).toContain("Nothing matches.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No instruction files found.");
    expect(detail()).toBeNull();
    expect(container.textContent).toContain("AGENTS.md, CLAUDE.md and similar files in projects with Sessions");
  });
});
