import type { IndexStatus } from "../core/indexer";
import type { SessionLoadOptions } from "../core/session-loader";

export interface SessionIndexWorkerData {
  connectionUrl: string;
  userDataPath: string;
}

// Only discovery settings cross this boundary, never loaded session contents or callbacks.
export type SessionIndexWorkerOptions = Pick<SessionLoadOptions,
  | "homeDir" | "includeStepcode" | "includeTclaude" | "includeTcodex"
  | "includeCodeBuddyCli" | "includeWorkBuddy" | "includeCodeWizCli"
  | "includeOpenClaw" | "includeHermes" | "includeOpenCode" | "includeZcode"
  | "includePi" | "includeKimiCli" | "includeQwenCode" | "includeGeminiCli"
  | "includeCursorAgent" | "includeTrae" | "includeQoder" | "includeQoderIde" | "includeDeepSeekCli"
>;

export interface SessionIndexWorkerRequest {
  requestId: number;
  loadOptions: SessionIndexWorkerOptions;
  retryFailures: boolean;
}

export type SessionIndexWorkerResponse =
  | { type: "progress"; requestId: number; status: IndexStatus }
  | { type: "environments-changed"; requestId: number }
  | { type: "result"; requestId: number; status: IndexStatus }
  | { type: "error"; requestId: number; error: string };
