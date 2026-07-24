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
} from "../../core/format-session";
import {
  getResumeCommand,
  openNativeApp,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  revealInFileManager,
  type AppSettings,
} from "../../core/platform";
import { routeResumeSession, type ResumeRouteResult } from "../../core/resume-router";
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

/**
 * Owns native actions launched from a Session card or detail page.
 *
 * Resume routing, remote preflight, and export fidelity stay behind one
 * interface instead of leaking platform branches into IPC registration.
 */
export class SessionCommandService {
  constructor(private readonly dependencies: SessionCommandServiceDependencies) {}

  async copyResumeCommand(sessionKey: string): Promise<void> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return;
    const options = session.environmentKind === "wsl"
      ? await this.dependencies.remoteAccess.requireWslResumeOptions(session)
      : { sshArgs: await this.dependencies.remoteAccess.requireSshArgs(session) };
    this.dependencies.copyText(getResumeCommand(session, this.dependencies.getSettings(), options));
  }

  async resume(sessionKey: string): Promise<ResumeRouteResult> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return { route: "resume" };
    if (session.environmentKind === "wsl") return this.resumeWsl(session);

    const sshArgs = await this.dependencies.remoteAccess.requireSshArgs(session);
    if (!isLocalSessionEnvironment(session)) {
      await this.dependencies.remoteAccess.ensureResumePreflight(session);
      await openResumeInTerminal(session, this.dependencies.getSettings(), { sshArgs });
      await this.dependencies.store.markResumed(sessionKey);
      return { route: "resume" };
    }

    const snapshot = await this.dependencies.loadLiveSessions();
    const route = routeResumeSession(session, snapshot.error ? [] : snapshot.sessions);
    if (route.route === "app") {
      await openNativeApp(session, { openExternal: this.dependencies.openExternal });
    } else if (route.route === "focus") {
      await focusLiveSessionTerminal(route.pid);
    } else {
      await openResumeInTerminal(session, this.dependencies.getSettings(), { sshArgs });
    }
    await this.dependencies.store.markResumed(sessionKey);
    return route;
  }

  async resumeInIterm(sessionKey: string): Promise<void> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return;
    if (session.environmentKind === "wsl") {
      await this.dependencies.remoteAccess.ensureWslResumePreflight(session);
      await openResumeInSpecificTerminal(
        session,
        this.dependencies.getSettings(),
        "iTerm",
        await this.dependencies.remoteAccess.requireWslResumeOptions(session),
      );
    } else {
      const sshArgs = await this.dependencies.remoteAccess.requireSshArgs(session);
      await this.dependencies.remoteAccess.ensureResumePreflight(session);
      await openResumeInSpecificTerminal(
        session,
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

  async exportMarkdown(sessionKey: string): Promise<boolean> {
    const content = await this.loadExportContent(sessionKey);
    if (!content) return false;
    const exportPath = await this.dependencies.chooseMarkdownPath(
      exportFileName(content.session, "md"),
    );
    if (!exportPath) return false;
    await this.dependencies.writeTextFile(
      exportPath,
      formatSessionMarkdown(content.session, content.messages, content.traceEvents),
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

  private async loadExportContent(sessionKey: string): Promise<SessionExportContent | null> {
    await this.dependencies.remoteAccess.ensureDetails(sessionKey);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session) return null;
    const [messages, traceEvents] = await Promise.all([
      this.dependencies.store.getAllMessages(sessionKey),
      this.dependencies.store.getTraceEvents(sessionKey),
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
      "codex-internal",
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
    const reconstructed = await reconstructCodexResponsesRequest(session.filePath);
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
