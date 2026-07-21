import { describe, expect, test } from "vitest";
import type { RuntimeConversation } from "../../../shared/types";
import { claudeRuntimeStateCodec } from "../claude/claude-runtime-state-codec";
import { codexRuntimeStateCodec } from "../codex/codex-runtime-state-codec";
import { hermesRuntimeStateCodec } from "../hermes/hermes-runtime-state-codec";
import { openClawRuntimeStateCodec } from "../openclaw/openclaw-runtime-state-codec";
import { openCodeRuntimeStateCodec } from "../opencode/opencode-runtime-state-codec";

function runtimeConversation(runtimeId: RuntimeConversation["runtimeId"], payload: Record<string, unknown>): RuntimeConversation {
  return {
    runtimeId,
    codecVersion: "v1",
    payload,
  };
}

describe("runtime state codecs", () => {
  test("codex codec restores, decodes, and clones runtime conversations without exposing malformed payloads", () => {
    const raw = runtimeConversation("codex", {
      native: { threadId: "thread-1", sessionTreeRootId: "root-1" },
      appContext: { cwd: "C:/repo", modelId: "gpt-5.5", approvalPolicy: "never" },
      extensions: { source: "test" },
    });

    const restored = codexRuntimeStateCodec.restorePersistedConversation(raw);

    expect(restored).toEqual(raw);
    expect(restored).not.toBe(raw);
    expect(codexRuntimeStateCodec.decodeConversation(restored)).toEqual({
      native: { threadId: "thread-1", sessionTreeRootId: "root-1" },
      appContext: { cwd: "C:/repo", modelId: "gpt-5.5", approvalPolicy: "never" },
      extensions: { source: "test" },
    });
    expect(codexRuntimeStateCodec.cloneConversation(restored!)).toEqual(raw);
    expect(
      codexRuntimeStateCodec.restorePersistedConversation(
        runtimeConversation("codex", {
          native: {},
        }),
      ),
    ).toBeUndefined();
    expect(
      codexRuntimeStateCodec.cloneConversation(
        runtimeConversation("codex", {
          native: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("claude codec restores resume payloads and rejects envelopes without a native session id", () => {
    const raw = runtimeConversation("claude", {
      native: { sessionId: "claude-session-1", projectKey: "project", subpaths: ["src"] },
      appContext: { cwd: "C:/repo", modelId: "claude-sonnet" },
      extensions: { source: "test" },
    });

    const restored = claudeRuntimeStateCodec.restorePersistedConversation(raw);

    expect(restored).toEqual(raw);
    expect(claudeRuntimeStateCodec.decodeConversation(restored)).toEqual({
      native: { sessionId: "claude-session-1", projectKey: "project", subpaths: ["src"] },
      appContext: { cwd: "C:/repo", modelId: "claude-sonnet" },
      extensions: { source: "test" },
    });
    expect(
      claudeRuntimeStateCodec.restorePersistedConversation(
        runtimeConversation("claude", {
          native: { projectKey: "missing-session-id" },
        }),
      ),
    ).toBeUndefined();
    expect(
      claudeRuntimeStateCodec.cloneConversation(
        runtimeConversation("claude", {
          native: { projectKey: "missing-session-id" },
        }),
      ),
    ).toBeUndefined();
  });

  test("hermes codec persists ACP session identity and rejects unsupported transports", () => {
    const raw = runtimeConversation("hermes", {
      native: { sessionId: "hermes-session-1" },
      appContext: { cwd: "/repo", modelId: "default", transport: "acp" },
    });

    expect(hermesRuntimeStateCodec.restorePersistedConversation(raw)).toEqual(raw);
    expect(hermesRuntimeStateCodec.decodeConversation(raw)).toEqual({
      native: { sessionId: "hermes-session-1" },
      appContext: { cwd: "/repo", modelId: "default", transport: "acp" },
    });
    expect(
      hermesRuntimeStateCodec.restorePersistedConversation(
        runtimeConversation("hermes", {
          native: { sessionId: "hermes-session-1" },
          appContext: { transport: "gateway" },
        }),
      ),
    ).toBeUndefined();
  });

  test("opencode codec persists ACP session identity and rejects malformed native state", () => {
    const raw = runtimeConversation("opencode", {
      native: { sessionId: "ses_opencode_1" },
      appContext: { cwd: "/repo", modelId: "openai/gpt-5", transport: "acp" },
    });
    expect(openCodeRuntimeStateCodec.restorePersistedConversation(raw)).toEqual(raw);
    expect(openCodeRuntimeStateCodec.decodeConversation(raw)).toEqual({
      native: { sessionId: "ses_opencode_1" },
      appContext: { cwd: "/repo", modelId: "openai/gpt-5", transport: "acp" },
    });
    expect(openCodeRuntimeStateCodec.restorePersistedConversation(runtimeConversation("opencode", {
      native: { sessionId: 42 },
    }))).toBeUndefined();
  });

  test("openclaw codec persists Gateway-backed ACP session identity", () => {
    const raw = runtimeConversation("openclaw", {
      native: { sessionId: "agent:main:acp-bridge:desktop" },
      appContext: { cwd: "/repo", modelId: "default", transport: "acp" },
    });
    expect(openClawRuntimeStateCodec.restorePersistedConversation(raw)).toEqual(raw);
    expect(openClawRuntimeStateCodec.decodeConversation(raw)?.native.sessionId).toBe("agent:main:acp-bridge:desktop");
  });
});
