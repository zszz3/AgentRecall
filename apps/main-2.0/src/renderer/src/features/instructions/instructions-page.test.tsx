// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryAgentStatus, PersonalLibrarySnapshot } from "../../../../shared/ipc/personal-library";
import { InstructionsPage } from "./instructions-page";

const agent = (id: LibraryAgentStatus["id"], name: string, extra: Partial<LibraryAgentStatus> = {}): LibraryAgentStatus =>
  ({ id, name, installed: true, enabled: false, state: "off", file: `/home/.${id}/AGENTS.md`, override: null, magpie: false, ...extra });

const snapshot = (instructions: string, agents: LibraryAgentStatus[], retiredKept: string[] = []): PersonalLibrarySnapshot => ({ instructions, agents, retiredKept });

describe("InstructionsPage", () => {
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

  const noTeams = { request: vi.fn(async () => ({ ok: true, data: { kind: "snapshot", value: { config: null, directories: [], busy: false } } })) };
  function install(api: Record<string, unknown>) {
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: { teamWorkspace: noTeams, ...api } });
  }
  const render = () => act(async () => root.render(createElement(InstructionsPage, { language: "en" })));
  const button = (text: string, scope: ParentNode = container) => {
    const found = [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const click = (element: HTMLElement) => act(async () => element.click());
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-agent="${id}"]`)!;
  const toggle = (id: string) => row(id).querySelector<HTMLInputElement>("input[role=switch]")!;
  function type(element: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("shows the file an agent would get before turning it on and saves edited instructions", async () => {
    const agents = [agent("claude-code", "Claude Code"), agent("cursor", "Cursor", { state: "unsupported", file: null })];
    const api = {
      getPersonalLibrary: vi.fn(async () => snapshot("Answer in Chinese.", agents)),
      previewPersonalLibraryAgent: vi.fn(async () => ({ file: "/home/.claude/CLAUDE.md", before: "", after: "BLOCK PREVIEW\n" })),
      setPersonalLibraryAgentEnabled: vi.fn(async () => snapshot("Answer in Chinese.", [agent("claude-code", "Claude Code", { enabled: true, state: "synced" }), agents[1]])),
      savePersonalLibraryInstructions: vi.fn(async (text: string) => snapshot(text, agents)),
    };
    install(api);
    await render();

    expect(toggle("cursor").disabled).toBe(true);
    await click(toggle("claude-code"));
    expect(api.previewPersonalLibraryAgent).toHaveBeenCalledWith("claude-code", true);
    expect(api.setPersonalLibraryAgentEnabled).not.toHaveBeenCalled();
    expect(row("claude-code").textContent).toContain("BLOCK PREVIEW");
    await click(button("Confirm", row("claude-code")));
    expect(api.setPersonalLibraryAgentEnabled).toHaveBeenCalledWith("claude-code", true);
    expect(row("claude-code").textContent).toContain("Written");

    expect(button("Save").disabled).toBe(true);
    await act(async () => type(container.querySelector("textarea")!, "Use English commits."));
    await click(button("Save"));
    expect(api.savePersonalLibraryInstructions).toHaveBeenCalledWith("Use English commits.");
  });

  it("lets the user keep the file's version of a changed block or overwrite it after confirming", async () => {
    const conflicted = snapshot("v2", [agent("codex", "Codex", { enabled: true, state: "conflict" })]);
    const api = {
      getPersonalLibrary: vi.fn(async () => conflicted),
      resolvePersonalLibraryConflict: vi.fn(async () => snapshot("v1 edited", [agent("codex", "Codex", { enabled: true, state: "synced" })])),
    };
    install(api);
    await render();
    expect(row("codex").textContent).toContain("Changed outside AgentRecall");
    expect(toggle("codex").disabled).toBe(true);

    await click(button("Overwrite the file"));
    expect(api.resolvePersonalLibraryConflict).not.toHaveBeenCalled();
    await click(button("Confirm"));
    expect(api.resolvePersonalLibraryConflict).toHaveBeenCalledWith("codex", "overwrite");
    expect(container.querySelector("textarea")!.value).toBe("v1 edited");
  });

  it("imports the chosen paragraphs and removes them from the files only when asked", async () => {
    const agents = [agent("claude-code", "Claude Code"), agent("codex", "Codex")];
    const api = {
      getPersonalLibrary: vi.fn(async () => snapshot("", agents)),
      listPersonalLibraryImports: vi.fn(async () => [
        { text: "Answer in Chinese.", agents: ["claude-code", "codex"] },
        { text: "Run tests first.", agents: ["claude-code"] },
      ]),
      importPersonalLibraryParagraphs: vi.fn(async () => snapshot("Answer in Chinese.", agents)),
    };
    install(api);
    await render();
    await click(button("Import from agents"));
    expect(container.textContent).toContain("Claude Code / Codex");
    const boxes = [...container.querySelectorAll<HTMLInputElement>(".instructions-import input[type=checkbox]")];
    await click(boxes[1]);
    await click(boxes[2]);
    await click(button("Add 1 paragraph"));
    expect(api.importPersonalLibraryParagraphs).toHaveBeenCalledWith(["Answer in Chinese."], true);
    expect(container.querySelector("textarea")!.value).toBe("Answer in Chinese.");
  });

  it("shows why a write was refused and keeps the page usable", async () => {
    install({
      getPersonalLibrary: vi.fn(async () => snapshot("", [agent("codex", "Codex")])),
      previewPersonalLibraryAgent: vi.fn(async () => { throw new Error("Error invoking remote method 'personal-library:preview': Error: Could not read /home/.codex/AGENTS.md: EACCES."); }),
    });
    await render();
    await click(toggle("codex"));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Could not read /home/.codex/AGENTS.md: EACCES.");
    expect(toggle("codex").disabled).toBe(false);
  });

  it("lets an agent whose file also has magpie's instructions be turned on and warns about duplicates", async () => {
    install({ getPersonalLibrary: vi.fn(async () => snapshot("", [agent("codex", "Codex", { magpie: true })])) });
    await render();
    expect(toggle("codex").disabled).toBe(false);
    expect(row("codex").textContent).toContain("This file also has instructions magpie wrote; they may repeat these.");
  });

  it("lists files kept from the retired Library sync until dismissed", async () => {
    const api = {
      getPersonalLibrary: vi.fn(async () => snapshot("", [], ["/home/.claude/commands/review.md"])),
      dismissPersonalLibraryRetiredKept: vi.fn(async () => snapshot("", [])),
    };
    install(api);
    await render();
    expect(container.textContent).toContain("/home/.claude/commands/review.md");
    await click(button("Got it"));
    expect(api.dismissPersonalLibraryRetiredKept).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("review.md");
  });

  it("shows the team's instructions below the personal ones", async () => {
    install({ getPersonalLibrary: vi.fn(async () => snapshot("", [])) });
    await render();
    const headings = [...container.querySelectorAll("h3")].map((item) => item.textContent);
    expect(headings.indexOf("Team instructions")).toBeGreaterThan(headings.indexOf("Agents"));
    expect(container.textContent).toContain("No team connected");
  });
});
