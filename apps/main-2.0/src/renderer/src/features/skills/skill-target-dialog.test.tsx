// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import { SKILL_INSTALL_TARGETS } from "../../../../core/agent-skill-registry";
import { SkillTargetDialog } from "./skill-target-dialog";

describe("SkillTargetDialog", () => {
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
  });

  it("renders a label for every supported installation target", async () => {
    const skill = createSkill({});

    await act(async () => root.render(createElement(SkillTargetDialog, {
      open: true,
      skill,
      busy: false,
      language: "zh",
      onClose: vi.fn(),
      onSave: vi.fn(async () => undefined),
    })));

    expect([...container.querySelectorAll(".managed-skill-target-options strong")].map((node) => node.textContent)).toEqual([
      "Codex",
      "Shared (~/.agents/skills)",
      "Claude Code",
      "Antigravity (agy)",
      "Cursor",
      "CodeBuddy",
      "Qoder",
      "Trae",
      "Pi",
    ]);
  });

  it("saves regular and forced conflicting targets without replacing either selection", async () => {
    const onSave = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const skill = createSkill({
      codex: "installed",
      claude: "conflict",
      qoder: "conflict",
    });

    await act(async () => root.render(createElement(SkillTargetDialog, {
      open: true,
      skill,
      busy: false,
      language: "en",
      onClose,
      onSave,
    })));

    const codex = targetButton(container, "Codex");
    const claude = targetButton(container, "Claude Code");
    const codeBuddy = targetButton(container, "CodeBuddy");
    const qoder = targetButton(container, "Qoder");

    expect(codex.getAttribute("role")).toBe("checkbox");
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(claude.getAttribute("role")).toBeNull();
    expect(claude.getAttribute("aria-pressed")).toBe("false");
    expect(claude.classList.contains("selected")).toBe(false);
    expect(claude.textContent).toContain("Force install");

    await click(codeBuddy);
    await click(claude);
    await click(qoder);

    expect(codeBuddy.getAttribute("aria-checked")).toBe("true");
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(claude.classList.contains("force-selected")).toBe(true);
    expect(claude.classList.contains("selected")).toBe(false);
    expect(qoder.getAttribute("aria-pressed")).toBe("true");
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".managed-skill-dialog-actions span")?.textContent)
      .toBe("2 regular · 2 force installs");

    await click(buttonWithText(container, "Save"));

    expect(onSave).toHaveBeenCalledWith(
      ["codex", "claude", "codebuddy", "qoder"],
      ["claude", "qoder"],
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels only the chosen force install and leaves installed targets selected", async () => {
    const onSave = vi.fn(async () => undefined);
    const skill = createSkill({
      codex: "installed",
      claude: "conflict",
      qoder: "conflict",
    });

    await act(async () => root.render(createElement(SkillTargetDialog, {
      open: true,
      skill,
      busy: false,
      language: "en",
      onClose: vi.fn(),
      onSave,
    })));

    const codex = targetButton(container, "Codex");
    const claude = targetButton(container, "Claude Code");
    const qoder = targetButton(container, "Qoder");

    await click(claude);
    await click(qoder);
    await click(claude);

    expect(claude.getAttribute("aria-pressed")).toBe("false");
    expect(claude.textContent).toContain("Force install");
    expect(qoder.getAttribute("aria-pressed")).toBe("true");
    expect(qoder.textContent).toContain("Cancel force");
    expect(codex.getAttribute("aria-checked")).toBe("true");

    await click(buttonWithText(container, "Save"));

    expect(onSave).toHaveBeenCalledWith(["codex", "qoder"], ["qoder"]);
  });
});

function createSkill(
  states: Partial<Record<(typeof SKILL_INSTALL_TARGETS)[number], ManagedSkill["installations"][number]["state"]>>,
): ManagedSkill {
  return {
    id: "skill-id",
    managedId: "skill-id",
    name: "Example Skill",
    description: "",
    agent: "codex",
    source: "agent-recall-v2",
    path: "C:/managed/skill-id/SKILL.md",
    directoryPath: "C:/managed/skill-id",
    rootPath: "C:/managed",
    markdown: "# Example",
    mtimeMs: 0,
    origin: { kind: "builtin", label: "AgentRecall" },
    categoryId: "coding",
    installations: SKILL_INSTALL_TARGETS.map((target) => ({
      target,
      path: `C:/target/${target}`,
      state: states[target] ?? "not-installed",
    })),
  };
}

function targetButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".managed-skill-target-options > button")]
    .find((candidate) => candidate.querySelector("strong")?.textContent === label);
  if (!button) throw new Error(`Missing target button: ${label}`);
  return button;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
