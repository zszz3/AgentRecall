import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionStore } from "../../core/session-store";
import type {
  EvaluationArtifactFile,
  EvaluationStageText,
  EvaluationStageTrace,
  EvaluationTrajectoryValue,
} from "../../core/evaluation/nodes/contracts";
import {
  artifactFilesFromTrace,
  filesTouchedByEvent,
  toolCalledByEvent,
} from "../../core/evaluation/artifact-files";

const ARTIFACT_OUTPUT_FILES = ["output.md", "answer.md", "OUTPUT.md", "ANSWER.md"];
const ARTIFACT_MAX_FILES = 500;

export interface EvaluationArtifactReader {
  readTrajectory(sessionKey: string): Promise<EvaluationTrajectoryValue | null>;
  readSessionArtifact(sessionKey: string): Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  readArtifactFiles(sessionKey: string): Promise<EvaluationArtifactFile[] | null>;
  readStageTrace(sessionKey: string): Promise<EvaluationStageTrace | null>;
  readStageTexts(sessionKey: string): Promise<EvaluationStageText[]>;
  readFolderArtifact(directory: string): Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
}

export function createEvaluationArtifactReader(deps: {
  getStore: () => SessionStore;
  isSkillUsageObservable: () => boolean;
}): EvaluationArtifactReader {
  /**
   * Which files a session's tool calls touched.
   *
   * Only the tool calls AgentRecall recognises are reported — see `artifactFilesFromTrace` —
   * so an empty result means "none seen", which is why the caller drops it rather than
   * storing an empty list.
   */
  const readArtifactFiles = async (sessionKey: string): Promise<EvaluationArtifactFile[] | null> => {
    const events = await deps.getStore().getTraceEvents(sessionKey);
    const files = artifactFilesFromTrace(events);
    return files.length > 0 ? files : null;
  };

  return {
    /**
     * How an agent worked, read from the session it produced.
     *
     * `skillUsageObservable` keeps the skill-use observation honest: the usage log only
     * exists when the hook is installed, so without it an empty trigger list means
     * "unknown" rather than "the skill went unused".
     */
    async readTrajectory(sessionKey: string): Promise<EvaluationTrajectoryValue | null> {
      const store = deps.getStore();
      const session = await store.getSession(sessionKey);
      if (!session) return null;
      const [turns, traceEvents, usedSkillNames] = await Promise.all([
        store.listSessionTurns(sessionKey),
        store.getTraceEvents(sessionKey),
        store.listSkillTriggersForSession(sessionKey),
      ]);
      const toolResults = traceEvents.filter((event) => event.kind === "tool_result");
      const failedToolResults = toolResults.filter((event) => event.status === "failed");
      return {
        sessionKey,
        turnCount: turns.length,
        toolCallCount: traceEvents.filter((event) => event.kind === "tool_call").length,
        toolFailureCount: failedToolResults.length,
        failedToolNames: [...new Set(failedToolResults.map((event) => event.title))].sort(),
        totalTokens: turns.length > 0
          ? turns.reduce((total, turn) => total + turn.inputTokens + turn.outputTokens, 0)
          : null,
        errorCount: traceEvents.filter(
          (event) => event.kind === "event" && event.status === "failed",
        ).length,
        usedSkillNames,
        skillUsageObservable: deps.isSkillUsageObservable(),
      };
    },

    /**
     * The artifact of a session that already happened: its final answer and touched files.
     */
    async readSessionArtifact(
      sessionKey: string,
    ): Promise<{ output: string; files?: EvaluationArtifactFile[] } | null> {
      const store = deps.getStore();
      const session = await store.getSession(sessionKey);
      if (!session) return null;
      const [messages, files] = await Promise.all([
        store.getAllMessages(sessionKey),
        readArtifactFiles(sessionKey),
      ]);
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      return {
        output: lastAssistant?.content ?? "",
        ...(files && files.length > 0 ? { files } : {}),
      };
    },

    readArtifactFiles,

    /**
     * Keeps where in the run each file touch and tool call happened so stage boundaries
     * can project ranges instead of folding everything into an end state.
     * Null is reserved for there being no trace to read at all.
     */
    async readStageTrace(sessionKey: string): Promise<EvaluationStageTrace | null> {
      const events = await deps.getStore().getTraceEvents(sessionKey);
      if (events.length === 0) return null;
      const trace: EvaluationStageTrace = { touches: [], tools: [] };
      for (const event of events) {
        for (const file of filesTouchedByEvent(event)) {
          trace.touches.push({ index: event.index, path: file.path, status: file.status });
        }
        const tool = toolCalledByEvent(event);
        if (tool) trace.tools.push({ index: event.index, tool });
      }
      return trace;
    },

    /**
     * Assistant text placed at the trace position it follows, using the merged sequence
     * produced during indexing rather than re-deriving order from timestamps.
     */
    async readStageTexts(sessionKey: string): Promise<EvaluationStageText[]> {
      const positions = await deps.getStore().getAssistantTextPositions(sessionKey);
      return positions.map((position) => ({
        index: position.traceIndex ?? -1,
        text: position.text,
      }));
    },

    /**
     * The artifact of a folder on disk: its files, plus a designated answer file when present.
     */
    async readFolderArtifact(
      directory: string,
    ): Promise<{ output: string; files?: EvaluationArtifactFile[] } | null> {
      const root = path.resolve(directory);
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) return null;
      } catch {
        return null;
      }
      const files: EvaluationArtifactFile[] = [];
      const walk = async (current: string): Promise<void> => {
        if (files.length >= ARTIFACT_MAX_FILES) return;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          if (files.length >= ARTIFACT_MAX_FILES) return;
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(entryPath);
          else if (entry.isFile()) {
            files.push({ path: path.relative(root, entryPath), status: "added" });
          }
        }
      };
      await walk(root);

      let output = "";
      for (const candidate of ARTIFACT_OUTPUT_FILES) {
        const candidatePath = path.join(root, candidate);
        if (files.some((file) => file.path === candidate)) {
          output = await fs.readFile(candidatePath, "utf8");
          break;
        }
      }
      return { output, files };
    },
  };
}
