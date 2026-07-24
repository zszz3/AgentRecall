import type { LiveSessionFamily, MigrationAgent, MigrationTarget, SessionFormat, SessionSource } from "./types";

export type OptionalSessionSourceSetting =
  | "includeClaudeInternal"
  | "includeCodexInternal"
  | "includeTclaude"
  | "includeTcodex"
  | "includeCodeBuddyCli"
  | "includeCodeWizCli"
  | "includeOpenClaw"
  | "includeHermes"
  | "includeOpenCode"
  | "includeZcode"
  | "includeCursorAgent"
  | "includeTrae"
  | "includeQoder";

export type SessionSourceFamily =
  | "claude"
  | "codex"
  | "tclaude"
  | "tcodex"
  | "codebuddy"
  | "codewiz"
  | "openclaw"
  | "hermes"
  | "opencode"
  | "zcode"
  | "cursor"
  | "trae"
  | "qoder";

export type SessionSourceUiFamily = "claude" | "codex" | "codebuddy" | "codewiz" | "zcode" | "other";

export interface SessionSourceCapabilities {
  live: boolean;
  resume: boolean;
  migrate: boolean;
  sessionSync: boolean;
  openApp: boolean;
}

export interface SessionSourceDescriptor {
  id: SessionSource;
  label: string;
  format: SessionFormat;
  family: SessionSourceFamily;
  uiFamily: SessionSourceUiFamily;
  statsGroup: "claude" | "codex" | null;
  optionalSetting: OptionalSessionSourceSetting | null;
  pendingKey: SessionSourceFamily | null;
  remoteCollectorOptional: boolean;
  liveFamily: LiveSessionFamily | null;
  migrationAgent: MigrationAgent | null;
  resumeTarget: MigrationTarget | null;
  remoteFamily: "claude" | "codex" | "codebuddy" | "codewiz" | "qoder" | null;
  nativeAppFamily: "claude" | "codex" | "codebuddy" | null;
  capabilities: SessionSourceCapabilities;
}

const fullCapabilities = (): SessionSourceCapabilities => ({
  live: true,
  resume: true,
  migrate: true,
  sessionSync: true,
  openApp: true,
});

export const SESSION_SOURCE_REGISTRY = {
  "claude-cli": {
    id: "claude-cli", label: "Claude Code", format: "claude", family: "claude", uiFamily: "claude", statsGroup: "claude",
    optionalSetting: null, pendingKey: null, remoteCollectorOptional: false, liveFamily: "claude", migrationAgent: "claude",
    resumeTarget: "claude", remoteFamily: "claude", nativeAppFamily: "claude", capabilities: fullCapabilities(),
  },
  "claude-app": {
    id: "claude-app", label: "Claude Code", format: "claude", family: "claude", uiFamily: "claude", statsGroup: "claude",
    optionalSetting: null, pendingKey: null, remoteCollectorOptional: false, liveFamily: "claude", migrationAgent: "claude",
    resumeTarget: "claude", remoteFamily: "claude", nativeAppFamily: "claude", capabilities: fullCapabilities(),
  },
  "claude-internal": {
    id: "claude-internal", label: "Claude Code Internal", format: "claude", family: "claude", uiFamily: "claude", statsGroup: null,
    optionalSetting: "includeClaudeInternal", pendingKey: "claude", remoteCollectorOptional: false, liveFamily: "claude", migrationAgent: "claude",
    resumeTarget: "claude-internal", remoteFamily: "claude", nativeAppFamily: "claude", capabilities: fullCapabilities(),
  },
  "codex-cli": {
    id: "codex-cli", label: "Codex", format: "codex", family: "codex", uiFamily: "codex", statsGroup: "codex",
    optionalSetting: null, pendingKey: null, remoteCollectorOptional: false, liveFamily: "codex", migrationAgent: "codex",
    resumeTarget: "codex", remoteFamily: "codex", nativeAppFamily: "codex", capabilities: fullCapabilities(),
  },
  "codex-app": {
    id: "codex-app", label: "Codex", format: "codex", family: "codex", uiFamily: "codex", statsGroup: "codex",
    optionalSetting: null, pendingKey: null, remoteCollectorOptional: false, liveFamily: "codex", migrationAgent: "codex",
    resumeTarget: "codex", remoteFamily: "codex", nativeAppFamily: "codex", capabilities: fullCapabilities(),
  },
  "codex-internal": {
    id: "codex-internal", label: "Codex Internal", format: "codex", family: "codex", uiFamily: "codex", statsGroup: null,
    optionalSetting: "includeCodexInternal", pendingKey: "codex", remoteCollectorOptional: false, liveFamily: "codex", migrationAgent: "codex",
    resumeTarget: "codex-internal", remoteFamily: "codex", nativeAppFamily: "codex", capabilities: fullCapabilities(),
  },
  "tclaude-cli": {
    id: "tclaude-cli", label: "TClaude", format: "claude", family: "tclaude", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeTclaude", pendingKey: "tclaude", remoteCollectorOptional: true, liveFamily: "tclaude", migrationAgent: "claude",
    resumeTarget: "tclaude", remoteFamily: "claude", nativeAppFamily: null,
    capabilities: { live: true, resume: true, migrate: true, sessionSync: true, openApp: false },
  },
  "tcodex-cli": {
    id: "tcodex-cli", label: "TCodex", format: "codex", family: "tcodex", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeTcodex", pendingKey: "tcodex", remoteCollectorOptional: true, liveFamily: "tcodex", migrationAgent: "codex",
    resumeTarget: "tcodex", remoteFamily: "codex", nativeAppFamily: null,
    capabilities: { live: true, resume: true, migrate: true, sessionSync: true, openApp: false },
  },
  "codebuddy-cli": {
    id: "codebuddy-cli", label: "CodeBuddy CLI", format: "codebuddy", family: "codebuddy", uiFamily: "codebuddy", statsGroup: null,
    optionalSetting: "includeCodeBuddyCli", pendingKey: "codebuddy", remoteCollectorOptional: true, liveFamily: "codebuddy", migrationAgent: "codebuddy",
    resumeTarget: "codebuddy", remoteFamily: "codebuddy", nativeAppFamily: "codebuddy", capabilities: fullCapabilities(),
  },
  "codewiz-cli": {
    id: "codewiz-cli", label: "CodeWiz", format: "codewiz", family: "codewiz", uiFamily: "codewiz", statsGroup: null,
    optionalSetting: "includeCodeWizCli", pendingKey: "codewiz", remoteCollectorOptional: false, liveFamily: "codewiz", migrationAgent: "codewiz",
    resumeTarget: "codewiz", remoteFamily: "codewiz", nativeAppFamily: null,
    capabilities: { live: true, resume: true, migrate: true, sessionSync: true, openApp: false },
  },
  openclaw: {
    id: "openclaw", label: "OpenClaw", format: "openclaw", family: "openclaw", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeOpenClaw", pendingKey: "openclaw", remoteCollectorOptional: false, liveFamily: "openclaw", migrationAgent: null,
    resumeTarget: null, remoteFamily: null, nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
  hermes: {
    id: "hermes", label: "Hermes", format: "hermes", family: "hermes", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeHermes", pendingKey: "hermes", remoteCollectorOptional: false, liveFamily: "hermes", migrationAgent: null,
    resumeTarget: null, remoteFamily: null, nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
  "opencode-cli": {
    id: "opencode-cli", label: "OpenCode", format: "opencode", family: "opencode", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeOpenCode", pendingKey: "opencode", remoteCollectorOptional: false, liveFamily: "opencode", migrationAgent: null,
    resumeTarget: null, remoteFamily: "codebuddy", nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
  "zcode-cli": {
    id: "zcode-cli", label: "ZCode", format: "zcode", family: "zcode", uiFamily: "zcode", statsGroup: null,
    optionalSetting: "includeZcode", pendingKey: "zcode", remoteCollectorOptional: false, liveFamily: "zcode", migrationAgent: null,
    resumeTarget: null, remoteFamily: null, nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
  "cursor-agent": {
    id: "cursor-agent", label: "Cursor Agent", format: "cursor", family: "cursor", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeCursorAgent", pendingKey: "cursor", remoteCollectorOptional: false, liveFamily: "cursor", migrationAgent: "cursor",
    resumeTarget: "cursor", remoteFamily: null, nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: true, sessionSync: true, openApp: false },
  },
  trae: {
    id: "trae", label: "Trae", format: "trae", family: "trae", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeTrae", pendingKey: "trae", remoteCollectorOptional: false, liveFamily: "trae", migrationAgent: null,
    resumeTarget: null, remoteFamily: null, nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
  qoder: {
    id: "qoder", label: "Qoder", format: "qoder", family: "qoder", uiFamily: "other", statsGroup: null,
    optionalSetting: "includeQoder", pendingKey: "qoder", remoteCollectorOptional: true, liveFamily: "qoder", migrationAgent: null,
    resumeTarget: null, remoteFamily: "qoder", nativeAppFamily: null,
    capabilities: { live: true, resume: false, migrate: false, sessionSync: false, openApp: false },
  },
} as const satisfies Record<SessionSource, SessionSourceDescriptor>;

export const SESSION_SOURCE_DESCRIPTORS = Object.values(SESSION_SOURCE_REGISTRY) as SessionSourceDescriptor[];

export const OPTIONAL_SESSION_SOURCE_DESCRIPTORS = SESSION_SOURCE_DESCRIPTORS.filter(
  (descriptor): descriptor is SessionSourceDescriptor & {
    optionalSetting: OptionalSessionSourceSetting;
    pendingKey: SessionSourceFamily;
  } => descriptor.optionalSetting !== null && descriptor.pendingKey !== null,
);

export function isSessionSource(value: unknown): value is SessionSource {
  return typeof value === "string" && Object.hasOwn(SESSION_SOURCE_REGISTRY, value);
}

export function sessionSourceDescriptor(source: SessionSource): SessionSourceDescriptor {
  return SESSION_SOURCE_REGISTRY[source];
}

export function sessionSourceLabel(source: SessionSource): string {
  return sessionSourceDescriptor(source).label;
}
