// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryAgentStatus, LibrarySyncAgentStatus, PersonalLibrarySnapshot } from "../../../../shared/ipc/personal-library";
import { LibraryPage } from "./library-page";

const agent = (id: LibraryAgentStatus["id"], name: string, extra: Partial<LibraryAgentStatus> = {}): LibraryAgentStatus =>
  ({ id, name, installed: true, enabled: false, state: "off", file: `/home/.${id}/AGENTS.md`, override: null, ...extra });

const snapshot = (instructions: string, agents: LibraryAgentStatus[], mcp: PersonalLibrarySnapshot["mcp"] = { servers: {}, agents: [] }): PersonalLibrarySnapshot =>
  ({ instructions, agents, mcp, commands: { items: {}, agents: [] }, subagents: { items: {}, agents: [] } });
const mcpAgent = (id: LibrarySyncAgentStatus["id"], name: string, extra: Partial<LibrarySyncAgentStatus> = {}): LibrarySyncAgentStatus =>
  ({ id, name, installed: true, enabled: false, state: "off", file: `/home/.${id}/mcp.json`, conflicts: [], problem: null, ...extra });

describe("LibraryPage", () => {
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

  function install(api: Record<string, unknown>) {
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
  }
  const render = () => act(async () => root.render(createElement(LibraryPage, { language: "en" })));
  const button = (text: string, scope: ParentNode = container) => {
    const found = [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const click = (element: HTMLElement) => act(async () => element.click());
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-agent="${id}"]`)!;
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

    expect(row("cursor").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    await click(row("claude-code").querySelector("input")!);
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
    expect(row("codex").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);

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
    const boxes = [...container.querySelectorAll<HTMLInputElement>(".library-import input[type=checkbox]")];
    await click(boxes[1]);
    await click(boxes[2]);
    await click(button("Add 1 to the Library"));
    expect(api.importPersonalLibraryParagraphs).toHaveBeenCalledWith(["Answer in Chinese."], true);
    expect(container.querySelector("textarea")!.value).toBe("Answer in Chinese.");
  });

  it("shows why a write was refused and keeps the page usable", async () => {
    install({
      getPersonalLibrary: vi.fn(async () => snapshot("", [agent("codex", "Codex")])),
      previewPersonalLibraryAgent: vi.fn(async () => { throw new Error("Error invoking remote method 'personal-library:preview': Error: /home/.codex/AGENTS.md is managed by magpie."); }),
    });
    await render();
    await click(row("codex").querySelector("input")!);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("/home/.codex/AGENTS.md is managed by magpie.");
    expect(row("codex").querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
  });

  it("edits MCP servers as JSON, previews what an agent's file gets and overwrites a conflict only when asked", async () => {
    const docs = { command: "npx", args: ["docs-mcp"] };
    const agents = [mcpAgent("claude-code", "Claude Code"), mcpAgent("codex", "Codex", { enabled: true, state: "conflict", conflicts: ["docs"] }), mcpAgent("pi", "Pi", { state: "unsupported", file: null })];
    const api = {
      getPersonalLibrary: vi.fn(async () => snapshot("", [], { servers: { docs }, agents })),
      savePersonalLibraryMcpServers: vi.fn(async (servers: Record<string, unknown>) => snapshot("", [], { servers: servers as PersonalLibrarySnapshot["mcp"]["servers"], agents })),
      previewPersonalLibraryMcp: vi.fn(async () => ({ file: "/home/.claude.json", add: ["docs"], update: [], remove: [], conflicts: [] })),
      setPersonalLibraryMcpAgentEnabled: vi.fn(async () => snapshot("", [], { servers: { docs }, agents: [mcpAgent("claude-code", "Claude Code", { enabled: true, state: "synced" }), agents[1]!, agents[2]!] })),
      overwritePersonalLibraryMcp: vi.fn(async () => snapshot("", [], { servers: { docs }, agents })),
    };
    install(api);
    await render();

    const editor = container.querySelector<HTMLTextAreaElement>(".library-mcp textarea")!;
    expect(JSON.parse(editor.value)).toEqual({ docs });
    await act(async () => type(editor, "{ broken"));
    const section = container.querySelector<HTMLElement>(".library-mcp")!;
    await click(button("Save", section));
    expect(api.savePersonalLibraryMcpServers).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not valid JSON");
    await act(async () => type(editor, JSON.stringify({ docs, web: { url: "https://mcp.example.com/mcp" } })));
    await click(button("Save", section));
    expect(api.savePersonalLibraryMcpServers).toHaveBeenCalledWith({ docs, web: { url: "https://mcp.example.com/mcp" } });

    const mcpRow = (id: string) => section.querySelector<HTMLElement>(`[data-sync-agent="${id}"]`)!;
    expect(mcpRow("pi").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    await click(mcpRow("claude-code").querySelector("input")!);
    expect(api.previewPersonalLibraryMcp).toHaveBeenCalledWith("claude-code", true);
    expect(mcpRow("claude-code").textContent).toContain("Adds: docs");
    expect(api.setPersonalLibraryMcpAgentEnabled).not.toHaveBeenCalled();
    await click(button("Confirm", mcpRow("claude-code")));
    expect(api.setPersonalLibraryMcpAgentEnabled).toHaveBeenCalledWith("claude-code", true);

    expect(mcpRow("codex").textContent).toContain("docs");
    await click(button("Overwrite", mcpRow("codex")));
    expect(api.overwritePersonalLibraryMcp).not.toHaveBeenCalled();
    await click(button("Confirm", mcpRow("codex")));
    expect(api.overwritePersonalLibraryMcp).toHaveBeenCalledWith("codex");
  });

  it("writes slash commands through the same section and imports them by name", async () => {
    const review = { description: "Review a change", body: "Review $ARGUMENTS." };
    const base = snapshot("", []);
    const commandAgent = mcpAgent("claude-code", "Claude Code", { file: "/home/.claude/commands" });
    const withCommands = (items: Record<string, typeof review>) => ({ ...base, commands: { items, agents: [commandAgent] } });
    const api = {
      getPersonalLibrary: vi.fn(async () => withCommands({})),
      listPersonalLibraryFileImports: vi.fn(async () => [{ name: "review", item: review, agents: ["claude-code"] }]),
      importPersonalLibraryFiles: vi.fn(async () => withCommands({ review })),
    };
    install(api);
    await render();
    const section = container.querySelector<HTMLElement>(".library-commands")!;
    await click(button("Import from agents", section));
    expect(api.listPersonalLibraryFileImports).toHaveBeenCalledWith("commands");
    expect(section.textContent).toContain("Review a change");
    await click(button("Add 1 to the Library", section));
    expect(api.importPersonalLibraryFiles).toHaveBeenCalledWith("commands", [{ name: "review", item: review }]);
    expect(JSON.parse(section.querySelector("textarea")!.value)).toEqual({ review });
  });
});
