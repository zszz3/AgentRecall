import type { AgentTestEvent } from "../../../../../shared/types";
import { runtimeModelId } from "../../../../../shared/models";
import { codexEnvironmentForChannel } from "../../../../agents/codex/codex-env";
import { codexAppServerConfigArgs, codexHome } from "../../../../channels/model-config";
import { execCli } from "../../../../platform/cli-launcher";
import type { RuntimeChannelTestContext } from "../../../../agents/runtime/runtime-driver";
import { runStreamingCommand } from "../../testing/agent-hub-cli";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { RUNTIME_CHANNEL_TEST_PROMPT, RUNTIME_CHANNEL_TEST_TIMEOUT_MS } from "../runtime-test-constants";
import { deleteCodexSessionFiles } from "./codex-cleanup";

type AgentTestEmit = (event: Omit<AgentTestEvent, "agentId" | "timestamp">) => void;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isCodexWarningMessage(message: string): boolean {
  return /skill descriptions were shortened/i.test(message) || /context budget/i.test(message);
}

function handleCodexTestLine(line: string, emit: AgentTestEmit): string {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: unknown; message?: unknown; command?: unknown };
      text?: unknown;
      message?: unknown;
      delta?: unknown;
    };
    if (event.type === "item.completed") {
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        emit({ type: "assistant", content: event.item.text });
        return event.item.text;
      }
      if (event.item?.type === "command_execution") {
        const command = typeof event.item.command === "string" ? event.item.command : JSON.stringify(event.item);
        emit({ type: "tool", content: command });
      }
      if (event.item?.type === "error") {
        const message = typeof event.item.message === "string" ? event.item.message : JSON.stringify(event.item);
        emit({ type: isCodexWarningMessage(message) ? "warning" : "error", content: message });
      }
    }
    if (event.type === "agent_message" && typeof event.text === "string") {
      emit({ type: "assistant", content: event.text });
      return event.text;
    }
    if (typeof event.delta === "string") {
      emit({ type: "assistant_delta", content: event.delta });
      return event.delta;
    }
    if (typeof event.message === "string") {
      emit({ type: "assistant", content: event.message });
      return event.message;
    }
  } catch {
    // Codex may write non-JSON diagnostics before its JSONL event stream starts.
  }
  return "";
}

function extractCodexSessionId(line: string): string | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const candidates = [
      raw.session_id,
      raw.sessionId,
      raw.thread_id,
      raw.threadId,
      raw.id,
      asRecord(raw.thread)?.id,
      asRecord(raw.session)?.id,
    ];
    return candidates.find((candidate): candidate is string => typeof candidate === "string" && /^[0-9a-f-]{36}$/i.test(candidate));
  } catch {
    return undefined;
  }
}

async function deleteCodexTestSessions(executable: string, home: string, sessionIds: Iterable<string>): Promise<number> {
  let deleted = 0;
  for (const sessionId of sessionIds) {
    try {
      await execCli({
        executable,
        args: ["archive", sessionId],
        cwd: process.cwd(),
        env: process.env,
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 64,
      });
    } catch {
      // Test cleanup is best-effort; local history deletion below is the required cleanup path.
    }
    try {
      deleted += await deleteCodexSessionFiles(home, sessionId);
    } catch {
      // A cleanup failure must not replace the actual channel-test result.
    }
  }
  return deleted;
}

export async function runCodexChannelTest(
  input: RuntimeChannelTestContext,
  options: RuntimeAgentExecutorFactoryOptions,
): Promise<string> {
  const channel = options.channelById(input.channelId);
  if (!channel) throw new Error(`Channel ${input.channelId} was not found.`);
  const executable = input.runtime.command || options.executables.codex;
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...codexAppServerConfigArgs(channel, input.modelId),
    RUNTIME_CHANNEL_TEST_PROMPT,
  ];
  input.emit({
    type: "phase",
    content: `Launching codex exec --ephemeral with model ${runtimeModelId(input.modelId) ?? "default"}.`,
  });
  let output = "";
  const sessionIds = new Set<string>();
  const result = await runStreamingCommand({
    executable,
    args,
    cwd: input.workDir,
    env: codexEnvironmentForChannel(channel),
    timeoutMs: RUNTIME_CHANNEL_TEST_TIMEOUT_MS,
    onStdoutLine: (line) => {
      const sessionId = extractCodexSessionId(line);
      if (sessionId) sessionIds.add(sessionId);
      const eventOutput = handleCodexTestLine(line, input.emit);
      if (eventOutput) output += eventOutput;
    },
    onStderr: (text) => input.emit({ type: "stderr", content: text }),
  });
  const deletedSessions = await deleteCodexTestSessions(executable, codexHome(), sessionIds);
  if (deletedSessions > 0) {
    input.emit({
      type: "phase",
      content: `Deleted ${deletedSessions} Codex test session${deletedSessions === 1 ? "" : "s"}.`,
    });
  }
  if (result.code !== 0) {
    throw new Error(`Codex test exited with ${result.code ?? result.signal ?? "unknown"}: ${result.stderr.trim().slice(0, 800)}`);
  }
  if (output.trim()) return output.trim();
  const stderrText = result.stderr.trim();
  throw new Error(stderrText ? `Codex completed without assistant text. stderr: ${stderrText}` : "Codex completed without assistant text.");
}
