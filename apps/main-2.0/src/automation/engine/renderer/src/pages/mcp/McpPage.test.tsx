// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  restart: vi.fn(),
  saveSecret: vi.fn(),
  deleteSecret: vi.fn(),
  authorizeOAuth: vi.fn(),
  revokeOAuth: vi.fn(),
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

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
}

function findArgumentsInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="-y @modelcontextprotocol/server-filesystem"]');
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

  it("preserves typed spaces, quoted Windows backslashes, and resyncs when switching servers", async () => {
    const first = server({
      id: "fs",
      name: "Filesystem",
      command: "npx",
      args: ["-y", "C:\\Users\\First Last\\repo", "it's ok", 'say "hi"'],
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
    const input = findArgumentsInput(container);
    expect(input.value).toBe('-y "C:\\Users\\First Last\\repo" "it\'s ok" \'say "hi"\'');

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

    await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(input.value).toBe(
      '-y "C:\\Users\\First Last\\repo" "\\\\server\\share\\My Folder" "C:\\Users\\O\'Connor\\repo" "--root=C:\\My Docs" \'{"k":"v"}\'',
    );

    model.draft = second;
    await act(async () => renderPage());
    expect(findArgumentsInput(container).value).toBe('--dir "D:\\Work Space\\server"');
  });
});
