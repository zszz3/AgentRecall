// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerDefinition } from "../../../../shared/mcp/types";

const model = vi.hoisted(() => ({
  servers: [] as McpServerDefinition[],
  draft: undefined as McpServerDefinition | undefined,
  dirty: false,
  busy: undefined,
  error: undefined,
  create: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  toggleTool: vi.fn(),
  save: vi.fn(),
  toggleEnabled: vi.fn(),
  toggleServerEnabled: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  importServers: vi.fn(),
  setDirty: vi.fn(),
}));

vi.mock("./useMcpRegistry", () => ({ useMcpRegistry: () => model }));

import { McpPage } from "./McpPage";

function server(overrides: Partial<McpServerDefinition>): McpServerDefinition {
  return {
    id: "custom",
    name: "Custom server",
    transport: "stdio",
    args: [],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("McpPage", () => {
  it("separates the three project MCPs from user-configured servers without exposing internal ids", () => {
    const sessionSearch = server({
      id: "agent-recall-session-search",
      name: "AgentRecall Session Search",
      managed: true,
      tools: [{ name: "search_sessions", inputSchema: {} }],
    });
    model.servers = [
      sessionSearch,
      server({ id: "agent-recall-skills", name: "AgentRecall Skills", managed: true }),
      server({ id: "team-docs", name: "Team docs" }),
    ];
    model.draft = sessionSearch;

    const html = renderToStaticMarkup(<McpPage language="zh" />);

    expect(html).toContain("AgentRecall 内置");
    expect(html).toContain("连接客户端");
    expect(html).toContain("直接工具");
    expect(html).toContain("list_skills · get_skill · search_sessions · get_session");
    expect(html).toContain("渐进式索引");
    expect(html).toContain("search_tools → get_tool → call_tool");
    expect(html).toContain("自定义");
    expect(html).toContain("AgentRecall 会话检索");
    expect(html).toContain("AgentRecall Skill 库");
    expect(html).toContain("检索已索引的 Agent 会话、查看上下文，并准备可恢复的迁移");
    expect(html).not.toContain("STDIO · agent-recall-session-search");
    expect(html).not.toContain("Agent 绑定");
  });

  it("renders an enable switch on every server row, custom and built-in", () => {
    model.servers = [
      server({ id: "agent-recall-skills", name: "AgentRecall Skills", managed: true }),
      server({ id: "team-docs", name: "Team docs" }),
    ];
    model.draft = model.servers[1];

    const html = renderToStaticMarkup(<McpPage language="zh" />);

    expect(html).toContain("mcp-registry-row");
    expect(html).toContain("mcp-registry-row-switch");
    // one switch per row (built-in + custom), plus the reused binding-switch style
    expect(html).toContain('aria-label="启用 Team docs"');
    expect(html).toContain('aria-label="启用 AgentRecall Skill 库"');
  });

  it("marks a disabled server row and reflects the switch as unchecked", () => {
    const teamDocs = server({ id: "team-docs", name: "Team docs", enabled: false });
    model.servers = [teamDocs];
    model.draft = teamDocs;

    const html = renderToStaticMarkup(<McpPage language="zh" />);

    expect(html).toContain("mcp-registry-row is-disabled");
    // an unchecked checkbox must not carry the checked attribute
    expect(html).not.toContain('aria-label="启用 Team docs" checked');
  });

  it("keeps the managed power button in the detail toolbar", () => {
    const skills = server({
      id: "agent-recall-skills",
      name: "AgentRecall Skills",
      managed: true,
    });
    model.servers = [skills];
    model.draft = skills;

    const html = renderToStaticMarkup(<McpPage language="zh" />);

    // managed servers still expose the original Power enable/disable button
    expect(html).toContain("禁用");
  });
});

it("exposes an accessible resize separator for the MCP source list", () => {
  const html = renderToStaticMarkup(<McpPage language="en" />);
  expect(html).toContain('aria-label="Resize MCP list"');
  expect(html).toContain('role="separator"');
});

// happy-dom does not implement @scope or browser layout. Keep the production
// rules and media queries, unwrapping only their outer scope; the real page is
// mounted under that same scope below. This tests scroll ownership, not pixels.
const rendererStyles = path.resolve(__dirname, "../../../../../../renderer/src/styles");
const scrollStyles = ["automation-upstream/part-05.css", "automation-upstream/part-06.css", "automation.css"]
  .map(file => {
    const css = readFileSync(path.join(rendererStyles, file), "utf8");
    return css.startsWith("@scope (.automation-page) {")
      ? css.replace(/^@scope \(\.automation-page\) \{/, "").replace(/\}\s*$/, "")
      : css;
  }).join("\n");

it.each([
  { width: 1200, stacked: false },
  { width: 700, stacked: false },
  { width: 480, stacked: true },
])("keeps a long MCP list as the scroll owner at viewport $width (stacked: $stacked)", async ({ width, stacked }) => {
  model.servers = Array.from({ length: 40 }, (_, index) => server({
    id: `scroll-server-${index}`, name: `Scroll server ${index}`,
  }));
  model.draft = undefined;
  const window = new Window({ width, height: 800 });
  try {
    const style = window.document.createElement("style");
    style.textContent = scrollStyles;
    window.document.head.append(style);
    window.document.body.innerHTML = `<div class="automation-page">${renderToStaticMarkup(<McpPage language="en" />)}</div>`;
    const split = window.document.querySelector(".resizable-split")!;
    // The existing ResizableSplit tests cover when this state is selected.
    split.setAttribute("data-stacked", String(stacked));
    const sidebar = window.document.querySelector(".workbench-browser")!;
    const header = sidebar.querySelector(".workbench-browser-header")!;
    const list = sidebar.querySelector(".workbench-browser-list")!;
    expect(header.parentElement).toBe(sidebar);
    expect(list.parentElement).toBe(sidebar);
    expect(list.querySelectorAll(".mcp-registry-row")).toHaveLength(40);
    expect(list.textContent).toContain("Scroll server 39");

    const sidebarStyle = window.getComputedStyle(sidebar);
    expect(sidebarStyle.display).toBe("flex");
    expect(sidebarStyle.flexDirection).toBe("column");
    expect(parseFloat(sidebarStyle.minHeight)).toBe(0);
    expect(sidebarStyle.overflow).toBe("hidden");
    expect(window.getComputedStyle(header).flexShrink).toBe("0");

    const listStyle = window.getComputedStyle(list);
    expect(listStyle.display).toBe("block");
    expect(listStyle.flexGrow).toBe("1");
    expect(parseFloat(listStyle.flexBasis)).toBe(0);
    expect(parseFloat(listStyle.minHeight)).toBe(0);
    expect(listStyle.height).toBe("auto");
    expect(listStyle.overflow).toBe("auto");
  } finally {
    await window.happyDOM.close();
  }
});

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findArgumentsInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="-y @modelcontextprotocol/server-filesystem"]',
  );
  if (!input) throw new Error("Arguments input not found");
  return input;
}

describe("McpPage STDIO arguments input", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    model.servers = [];
    model.draft = undefined;
    model.dirty = false;
    model.busy = undefined;
    model.error = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("formats existing arguments containing whitespace or quotes with double quotes", async () => {
    const filesystem = server({
      id: "fs",
      name: "Filesystem",
      command: "npx",
      args: ["-y", "C:\\Users\\First Last\\repo", "it's ok", 'say "hi"'],
    });
    model.servers = [filesystem];
    model.draft = filesystem;

    await act(async () => root.render(<McpPage language="en" />));

    expect(findArgumentsInput(container).value).toBe(
      '-y "C:\\Users\\First Last\\repo" "it\'s ok" \'say "hi"\'',
    );
  });

  it("preserves typed spaces and quoted Windows backslashes across stateful re-renders", async () => {
    const filesystem = server({ id: "fs", name: "Filesystem", command: "npx", args: [] });
    model.servers = [filesystem];
    model.draft = filesystem;
    const renderPage = () => root.render(<McpPage language="en" />);
    model.update.mockImplementation((next: McpServerDefinition) => {
      model.draft = next;
      model.dirty = true;
      renderPage();
    });

    await act(async () => renderPage());
    const input = findArgumentsInput(container);

    await setInputValue(input, "-y ");
    expect(input.value).toBe("-y ");
    expect(model.draft.args).toEqual(["-y"]);

    await setInputValue(input, "-y   ");
    expect(input.value).toBe("-y   ");

    await setInputValue(input, '-y "C:\\Users\\First ');
    expect(input.value).toBe('-y "C:\\Users\\First ');
    expect(model.draft.args).toEqual(["-y", "C:\\Users\\First "]);

    await setInputValue(input, '-y "C:\\Users\\First Last\\repo"');
    expect(input.value).toBe('-y "C:\\Users\\First Last\\repo"');
    expect(model.draft.args).toEqual(["-y", "C:\\Users\\First Last\\repo"]);

    await setInputValue(
      input,
      '-y "C:\\Users\\First Last\\repo" "\\\\server\\share\\My Folder" C:\\Users\\O\'Connor\\repo --root="C:\\My Docs" \'{"k":"v"}\'',
    );
    expect(model.draft.args).toEqual([
      "-y",
      "C:\\Users\\First Last\\repo",
      "\\\\server\\share\\My Folder",
      "C:\\Users\\O'Connor\\repo",
      "--root=C:\\My Docs",
      '{"k":"v"}',
    ]);

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(input.value).toBe(
      '-y "C:\\Users\\First Last\\repo" "\\\\server\\share\\My Folder" "C:\\Users\\O\'Connor\\repo" "--root=C:\\My Docs" \'{"k":"v"}\'',
    );
  });

  it("resyncs the raw input when switching servers or applying external draft updates", async () => {
    const first = server({
      id: "first",
      name: "First",
      command: "npx",
      args: ["-y", "C:\\Program Files\\Tool"],
    });
    const second = server({
      id: "second",
      name: "Second",
      command: "uvx",
      args: ["--dir", "D:\\Work Space\\server"],
    });
    model.servers = [first, second];
    model.draft = first;
    const renderPage = () => root.render(<McpPage language="en" />);
    model.update.mockImplementation((next: McpServerDefinition) => {
      model.draft = next;
      model.dirty = true;
      renderPage();
    });

    await act(async () => renderPage());
    expect(findArgumentsInput(container).value).toBe('-y "C:\\Program Files\\Tool"');

    // Type trailing spaces, then switch to another server
    await setInputValue(findArgumentsInput(container), "-y   ");
    expect(findArgumentsInput(container).value).toBe("-y   ");

    model.draft = second;
    await act(async () => renderPage());
    expect(findArgumentsInput(container).value).toBe('--dir "D:\\Work Space\\server"');

    // External update on the same server (e.g. applying JSON edits)
    model.draft = { ...second, args: ["--port", "3000", "E:\\My Projects\\mcp"] };
    await act(async () => renderPage());
    expect(findArgumentsInput(container).value).toBe('--port 3000 "E:\\My Projects\\mcp"');
  });
});
