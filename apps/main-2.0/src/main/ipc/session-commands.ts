import type { IpcMain } from "electron";
import type { SessionMarkdownExportOptions } from "../../core/format-session";
import type { SessionCommandService } from "../services/session-command-service";

export function registerSessionCommandIpc(
  ipc: Pick<IpcMain, "handle">,
  service: SessionCommandService,
): void {
  ipc.handle("session:context-components", (_event, sessionKey: string) =>
    service.getContextComponents(sessionKey));
  ipc.handle("command:copy-resume", (_event, sessionKey: string) =>
    service.copyResumeCommand(sessionKey));
  ipc.handle("command:resume", (_event, sessionKey: string) => service.resume(sessionKey));
  ipc.handle("command:resume-iterm", (_event, sessionKey: string) =>
    service.resumeInIterm(sessionKey));
  ipc.handle("command:open-app", (_event, sessionKey: string) => service.openApp(sessionKey));
  ipc.handle("command:reveal", (_event, sessionKey: string) => service.reveal(sessionKey));
  ipc.handle("command:copy-markdown", (_event, sessionKey: string) =>
    service.copyMarkdown(sessionKey));
  ipc.handle("command:export-markdown", (
    _event,
    sessionKey: string,
    options?: SessionMarkdownExportOptions,
  ) => service.exportMarkdown(sessionKey, options));
  ipc.handle("command:export-json", (_event, sessionKey: string) =>
    service.exportJson(sessionKey));
  ipc.handle("command:copy-plain", (_event, sessionKey: string) =>
    service.copyPlainText(sessionKey));
}
