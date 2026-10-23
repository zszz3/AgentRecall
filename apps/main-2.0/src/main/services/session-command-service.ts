import { homedir } from "node:os";
import {
  reconstructCodexResponsesRequest,
  resolveCodexResponsesRequest,
  type CodexRequestExport,
  type CodexRequestFidelity,
} from "../../core/codex-request-export";
import {
  formatSessionJson,
  formatSessionMarkdown,
  formatSessionPlainText,
  type SessionJsonExportFormat,
  type SessionMarkdownExportOptions,
} from "../../core/format-session";
import {
  getResumeCommand,
  openDeepSeekWebInTerminal,
  openNativeApp,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  probeDeepSeekWeb,
  revealInFileManager,
  waitForDeepSeekWeb,
  type AppSettings,
} from "../../core/platform";
import { routeResumeSession, type ResumeRouteResult } from "../../core/resume-router";
import {
  extractSessionContextComponents,
  type SessionContextComponents,
} from "../../core/session-context-components";
import { focusLiveSessionTerminal } from "../../core/session-focus";
import { isLocalSessionEnvironment } from "../../core/session-environment";
import type { SessionStore } from "../../core/session-store";
import type {
  LiveSessionSnapshot,
  SessionMessage,
  SessionSearchResult,
  SessionTraceEvent,
} from "../../core/types";
import type { SessionJsonExportFormat as JsonExportFormat } from "../../core/format-session";
import type { RemoteSessionAccess } from "./remote-session-access";

export interface SessionCommandServiceDependencies {
  store: SessionStore;
  remoteAccess: RemoteSessionAccess;
  getSettings(): AppSettings;
  loadLiveSessions(): Promise<LiveSessionSnapshot>;
  copyText(text: string): void;
  openExternal(url: string): Promise<unknown>;
  openDeepSeekWebSession(sessionId: string): Promise<void>;
  chooseMarkdownPath(defaultFileName: string): Promise<string | null>;
  chooseJsonFormat(): Promise<JsonExportFormat | null>;
  chooseJsonPath(defaultFileName: string): Promise<string | null>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  showJsonExportNotice(
    filePath: string,
    fidelity: CodexRequestFidelity,
  ): Promise<void>;
}

export interface SessionJsonExportResult {
  exported: boolean;
  fidelity?: CodexRequestFidelity;
}

type SessionExportContent = {
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
};

export function nativeResumeSession(session: SessionSearchResult): SessionSearchResult {
  if (session.source === "stepcode-claude") return { ...session, source: "claude-cli" };
  if (session.source === "stepcode-codex") return { ...session, source: "codex-cli" };
  return session;
}

/**
 * Owns native actions launched from a Session card or detail page.
 *
 * Resume routing, remote preflight, and export fidelity stay behind one
 * interface instead of leaking platform branches into IPC registration.
 */
export class SessionCommandService {
  constructor(private readonly dependencies: SessionCommandServiceDependencies) {}

  async getContextComponents(sessionKey: string): Promise<SessionContextComponents> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) {
      return {
        status: "source_unavailable",
        source: "codex-cli",
        format: null,
        components: [],
      };
    }
    try {
      return await extractSessionContextComponents({
        source: session.source,
        rawId: session.rawId,
        filePath: isLocalSessionEnvironment(session) ? session.filePath : null,
        sourceAvailable: session.sourceAvailable,
      });
    } catch {
      return {
        status: "source_unavailable",
        source: session.source,
        format: null,
        components: [],
      };
    }
  }

  async copyResumeCommand(sessionKey: string): Promise<void> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return;
    const resumeSession = nativeResumeSession(session);
    const options = resumeSession.environmentKind === "wsl"
      ? await this.dependencies.remoteAccess.requireWslResumeOptions(resumeSession)
      : { sshArgs: await this.dependencies.remoteAccess.requireSshArgs(resumeSession) };
    this.dependencies.copyText(getResumeCommand(resumeSession, this.dependencies.getSettings(), options));
  }

  async resume(sessionKey: string): Promise<ResumeRouteResult> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return { route: "resume" };
    const resumeSession = nativeResumeSession(session);
    if (resumeSession.environmentKind === "wsl") return this.resumeWsl(resumeSession);

    const sshArgs = await this.dependencies.remoteAccess.requireSshArgs(resumeSession);
    if (!isLocalSessionEnvironment(resumeSession)) {
      await this.dependencies.remoteAccess.ensureResumePreflight(resumeSession);
      await openResumeInTerminal(resumeSession, this.dependencies.getSettings(), { sshArgs });
      await this.dependencies.store.markResumed(sessionKey);
      return { route: "resume" };
    }

    if (session.source === "deepseek-cli") {
      if (!await probeDeepSeekWeb()) {
        await openDeepSeekWebInTerminal(session.projectPath || homedir(), this.dependencies.getSettings());
        if (!await waitForDeepSeekWeb()) {
          throw new Error("DeepSeek Harness Web did not start on http://127.0.0.1:3080.");
        }
      }
      await this.dependencies.openDeepSeekWebSession(session.rawId);
      await this.dependencies.store.markResumed(sessionKey);
      return { route: "resume" };
    }

    const snapshot = await this.dependencies.loadLiveSessions();
    const route = routeResumeSession(resumeSession, snapshot.error ? [] : snapshot.sessions);
    if (route.route === "app") {
      await openNativeApp(resumeSession, { openExternal: this.dependencies.openExternal });
    } else if (route.route === "focus") {
      await focusLiveSessionTerminal(route.pid);
    } else {
      await openResumeInTerminal(resumeSession, this.dependencies.getSettings(), { sshArgs });
    }
    await this.dependencies.store.markResumed(sessionKey);
    return route;
  }

  async resumeWithStepcode(sessionKey: string): Promise<void> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || !isLocalSessionEnvironment(session)) return;
    const settings = this.dependencies.getSettings();
    if (!settings.includeStepcode) return;
    const stepcodeSource =
      session.source === "claude-cli"
      || session.source === "claude-app"
      || session.source === "stepcode-claude"
        ? "stepcode-claude"
        : session.source === "codex-cli"
          || session.source === "codex-app"
          || session.source === "stepcode-codex"
          ? "stepcode-codex"
          : null;
    if (!stepcodeSource) return;
    await openResumeInTerminal({ ...session, source: stepcodeSource }, settings);
    await this.dependencies.store.markResumed(sessionKey);
  }

  async resumeInIterm(sessionKey: string): Promise<void> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return;
    const resumeSession = nativeResumeSession(session);
    if (resumeSession.environmentKind === "wsl") {
      await this.dependencies.remoteAccess.ensureWslResumePreflight(resumeSession);
      await openResumeInSpecificTerminal(
        resumeSession,
        this.dependencies.getSettings(),
        "iTerm",
        await this.dependencies.remoteAccess.requireWslResumeOptions(resumeSession),
      );
    } else {
      const sshArgs = await this.dependencies.remoteAccess.requireSshArgs(resumeSession);
      await this.dependencies.remoteAccess.ensureResumePreflight(resumeSession);
      await openResumeInSpecificTerminal(
        resumeSession,
        this.dependencies.getSettings(),
        "iTerm",
        { sshArgs },
      );
    }
    await this.dependencies.store.markResumed(sessionKey);
  }

  async openApp(sessionKey: string): Promise<boolean> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || !isLocalSessionEnvironment(session)) return false;
    await openNativeApp(session, { openExternal: this.dependencies.openExternal });
    return true;
  }

  async reveal(sessionKey: string): Promise<boolean> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || !isLocalSessionEnvironment(session)) return false;
    await revealInFileManager(session.projectPath || session.filePath);
    return true;
  }

  async copyMarkdown(sessionKey: string): Promise<void> {
    const content = await this.loadExportContent(sessionKey);
    if (!content) return;
    this.dependencies.copyText(formatSessionMarkdown(
      content.session,
      content.messages,
      content.traceEvents,
    ));
  }

  async exportMarkdown(
    sessionKey: string,
    options?: SessionMarkdownExportOptions,
  ): Promise<boolean> {
    const content = await this.loadExportContent(sessionKey, options?.includeToolTrace !== false);
    if (!content) return false;
    const exportPath = await this.dependencies.chooseMarkdownPath(
      exportFileName(content.session, "md"),
    );
    if (!exportPath) return false;
    await this.dependencies.writeTextFile(
      exportPath,
      formatSessionMarkdown(content.session, content.messages, content.traceEvents, {
        includeToolTrace: options?.includeToolTrace !== false,
      }),
    );
    return true;
  }

  async exportJson(sessionKey: string): Promise<SessionJsonExportResult> {
    await this.dependencies.remoteAccess.ensureDetails(sessionKey);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return { exported: false };
    const format = await this.dependencies.chooseJsonFormat();
    if (!format) return { exported: false };
    const exportPath = await this.dependencies.chooseJsonPath(exportFileName(session, "json"));
    if (!exportPath) return { exported: false };

    const codexRequest = await this.resolveCodexRequest(session, format);
    const fidelity = codexRequest?.fidelity ?? "normalized";
    await this.dependencies.writeTextFile(
      exportPath,
      formatSessionJson(
        await this.dependencies.store.getAllMessages(sessionKey),
        format,
        codexRequest?.body,
      ),
    );
    await this.dependencies.showJsonExportNotice(exportPath, fidelity);
    return { exported: true, fidelity };
  }

  async copyPlainText(sessionKey: string): Promise<void> {
    const content = await this.loadExportContent(sessionKey);
    if (!content) return;
    this.dependencies.copyText(formatSessionPlainText(
      content.session,
      content.messages,
      content.traceEvents,
    ));
  }

  private async resumeWsl(session: SessionSearchResult): Promise<ResumeRouteResult> {
    const options = await this.dependencies.remoteAccess.requireWslResumeOptions(session);
    await this.dependencies.remoteAccess.ensureWslResumePreflight(session);
    await openResumeInTerminal(session, this.dependencies.getSettings(), options);
    await this.dependencies.store.markResumed(session.sessionKey);
    return { route: "resume" };
  }

  private async loadExportContent(
    sessionKey: string,
    includeToolTrace = true,
  ): Promise<SessionExportContent | null> {
    await this.dependencies.remoteAccess.ensureDetails(sessionKey);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return null;
    const [messages, traceEvents] = await Promise.all([
      this.dependencies.store.getAllMessages(sessionKey),
      includeToolTrace
        ? this.dependencies.store.getTraceEvents(sessionKey)
        : Promise.resolve([]),
    ]);
    return { session, messages, traceEvents };
  }

  private async resolveCodexRequest(
    session: SessionSearchResult,
    format: SessionJsonExportFormat,
  ): Promise<CodexRequestExport | null> {
    const isCodexSession = [
      "codex-cli",
      "codex-app",
      "stepcode-codex",
      "tcodex-cli",
    ].includes(session.source);
    if (!isCodexSession || !isLocalSessionEnvironment(session)) return null;
    if (format === "openai_responses") {
      return resolveCodexResponsesRequest({
        filePath: session.filePath,
        rawId: session.rawId,
        traceRoot: process.env.CODEX_ROLLOUT_TRACE_ROOT?.trim() || undefined,
      });
    }
    const reconstructed = await reconstructCodexResponsesRequest(session.filePath, session.rawId);
    return reconstructed ? { body: reconstructed, fidelity: "reconstructed" } : null;
  }
}

function exportFileName(
  session: SessionSearchResult,
  extension: "md" | "json",
): string {
  const title = session.displayTitle || session.originalTitle || session.rawId;
  const safeTitle = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeTitle || "session"}.${extension}`;
}
