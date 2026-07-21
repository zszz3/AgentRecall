import { describe, expect, test } from "vitest";
import { planSessionReconfigure } from "./session-reconfigure";

const current = {
  chatId: "chat-1",
  configuredAgentId: "codex-agent",
  runtimeId: "codex",
  executionMode: "interactive",
  continuationPolicy: "resume-preferred",
  runtime: { id: "codex", label: "Codex", command: "codex", version: "test", available: true },
  channelId: "codex-openai",
  workDir: "C:/repo",
  runtimeConfig: { model: "gpt-5.5" },
  developerInstructions: "test",
  emit: () => undefined,
} as const;

describe("planSessionReconfigure", () => {
  test("treats a model change as attach-boundary but not identity-breaking", () => {
    const plan = planSessionReconfigure(current, { ...current, runtimeConfig: { model: "default" } });
    expect(plan.invalidateResume).toBe(false);
    expect(plan.requiresSessionRecreate).toBe(false);
    expect(plan.applyOnNextAttach).toMatchObject({ runtimeConfig: { model: "default" } });
  });

  test("treats a workDir change as identity-breaking for native resume", () => {
    const plan = planSessionReconfigure(current, { ...current, workDir: "C:/other-repo" });
    expect(plan.invalidateResume).toBe(true);
    expect(plan.applyOnNextAttach).toMatchObject({ workDir: "C:/other-repo" });
  });

  test("treats a runtime family change as session recreation", () => {
    const plan = planSessionReconfigure(current, {
      ...current,
      runtimeId: "claude",
      runtime: { id: "claude", label: "Claude", command: "claude", version: "test", available: true },
      channelId: "claude-code",
    });
    expect(plan.requiresSessionRecreate).toBe(true);
    expect(plan.invalidateResume).toBe(true);
  });
});
