import type { IndexStatus } from "../core/indexer";
import type { SessionLoadOptions } from "../core/session-loader";
import type { SessionSource } from "../core/types";

export type SessionIndexWorkerLoadOptions = Pick<
  SessionLoadOptions,
  | "homeDir"
  | "includeTclaude"
  | "includeTcodex"
  | "includeCodeBuddyCli"
  | "includeWorkBuddy"
  | "includeCodeWizCli"
  | "includeOpenClaw"
  | "includeHermes"
  | "includeOpenCode"
  | "includeZcode"
  | "includePi"
  | "includeKimiCli"
  | "includeCursorAgent"
  | "includeTrae"
  | "includeQoder"
  | "includeDeepSeekCli"
>;

interface SessionIndexWorkerBaseInput {
  dbPath: string;
  userDataPath: string;
}

export interface SessionIndexWorkerRunInput extends SessionIndexWorkerBaseInput {
  type: "index";
  batchSize: number;
  timeBudgetMs: number;
  loadOptions: SessionIndexWorkerLoadOptions;
  disabledSources: SessionSource[];
}

export interface SessionIndexWorkerPruneInput extends SessionIndexWorkerBaseInput {
  type: "prune-sources";
  sources: SessionSource[];
}

export type SessionIndexWorkerInput = SessionIndexWorkerRunInput | SessionIndexWorkerPruneInput;

export type SessionIndexWorkerResult =
  | { type: "index"; status: IndexStatus }
  | { type: "prune-sources" };

export type SessionIndexWorkerMessage =
  | { type: "progress"; status: IndexStatus }
  | { type: "environments-changed" }
  | { type: "result"; result: SessionIndexWorkerResult }
  | { type: "error"; error: string };
