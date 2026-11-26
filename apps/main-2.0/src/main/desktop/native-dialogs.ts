import { app, BrowserWindow, dialog, webContents } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexRequestFidelity } from "../../core/codex-request-export";
import type { SessionJsonExportFormat } from "../../core/format-session";

export interface NativeDialogs {
  pickAutomationDirectory(defaultPath?: string): Promise<string | undefined>;
  chooseMarkdownExportPath(defaultFileName: string): Promise<string | null>;
  chooseJsonExportFormat(): Promise<SessionJsonExportFormat | null>;
  chooseJsonExportPath(defaultFileName: string): Promise<string | null>;
  showJsonExportNotice(exportPath: string, fidelity: CodexRequestFidelity): Promise<void>;
  chooseLocalProjectDirectory(): Promise<string | null>;
  chooseProviderConfigDirectory(
    target: "codex" | "claude" | "summary",
    defaultPath?: string,
  ): Promise<string | null>;
  chooseEvaluationDatasetDirectory(mode: "read" | "write"): Promise<string | null>;
  saveFromOwnerWindow(
    owner: number,
    bytes: Uint8Array,
    options: Electron.SaveDialogOptions,
  ): Promise<boolean>;
  confirmTeamOperation(owner: number, message: string): Promise<boolean>;
  chooseFolderFromOwnerWindow(
    owner: number,
    options: Electron.OpenDialogOptions,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

function resolveOwnerWindow(owner: number): BrowserWindow | null {
  const sender = webContents.fromId(owner);
  return sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
}

export function createNativeDialogs(options: {
  getMainWindow: () => BrowserWindow | null;
}): NativeDialogs {
  const showOpenDialog = (dialogOptions: Electron.OpenDialogOptions) => {
    const mainWindow = options.getMainWindow();
    return mainWindow
      ? dialog.showOpenDialog(mainWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);
  };

  const showSaveDialog = (dialogOptions: Electron.SaveDialogOptions) => {
    const mainWindow = options.getMainWindow();
    return mainWindow
      ? dialog.showSaveDialog(mainWindow, dialogOptions)
      : dialog.showSaveDialog(dialogOptions);
  };

  const showMessageBox = (dialogOptions: Electron.MessageBoxOptions) => {
    const mainWindow = options.getMainWindow();
    return mainWindow
      ? dialog.showMessageBox(mainWindow, dialogOptions)
      : dialog.showMessageBox(dialogOptions);
  };

  return {
    async pickAutomationDirectory(defaultPath?: string): Promise<string | undefined> {
      const result = await showOpenDialog({
        title: "Choose working directory",
        defaultPath: defaultPath || app.getPath("home"),
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },

    async chooseMarkdownExportPath(defaultFileName: string): Promise<string | null> {
      const result = await showSaveDialog({
        title: "Export Markdown",
        defaultPath: path.join(app.getPath("documents"), defaultFileName),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return null;
      return path.extname(result.filePath) ? result.filePath : `${result.filePath}.md`;
    },

    async chooseJsonExportFormat(): Promise<SessionJsonExportFormat | null> {
      const result = await showMessageBox({
        type: "question",
        title: "Export JSON",
        message: "Choose an API request format",
        detail: "Codex exports use an exact captured request when available, otherwise a reconstructed request. Other sessions use normalized messages.",
        buttons: ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      });
      return (["openai_chat", "openai_responses", "anthropic"] as const)[result.response] ?? null;
    },

    async chooseJsonExportPath(defaultFileName: string): Promise<string | null> {
      const result = await showSaveDialog({
        title: "Export JSON",
        defaultPath: path.join(app.getPath("documents"), defaultFileName),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return null;
      return path.extname(result.filePath) ? result.filePath : `${result.filePath}.json`;
    },

    async showJsonExportNotice(exportPath: string, fidelity: CodexRequestFidelity): Promise<void> {
      const fidelityMessage = fidelity === "exact-trace"
        ? "Exact Codex request body captured from CODEX_ROLLOUT_TRACE_ROOT."
        : fidelity === "reconstructed"
          ? "Request body reconstructed from the Codex rollout history."
          : "Request body exported in normalized message format.";
      const fidelityMessageZh = fidelity === "exact-trace"
        ? "已从 CODEX_ROLLOUT_TRACE_ROOT 导出 Codex 原始请求体。"
        : fidelity === "reconstructed"
          ? "已根据 Codex rollout 历史重建请求体。"
          : "已按标准消息格式导出请求体。";
      await showMessageBox({
        type: "info",
        title: "JSON Export Complete",
        message: fidelityMessage,
        detail: `${fidelityMessageZh}\n\n${exportPath}`,
        buttons: ["OK"],
        noLink: true,
      });
    },

    async chooseLocalProjectDirectory(): Promise<string | null> {
      const result = await showOpenDialog({
        title: "Choose local project directory",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },

    async chooseProviderConfigDirectory(
      target: "codex" | "claude" | "summary",
      defaultPath?: string,
    ): Promise<string | null> {
      const label = target === "claude" ? "Claude Code" : target === "summary" ? "summary Provider" : "Codex";
      const result = await showOpenDialog({
        title: `Choose ${label} config directory`,
        properties: ["openDirectory", "createDirectory"],
        ...(defaultPath?.trim() ? { defaultPath: defaultPath.trim() } : {}),
      });
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },

    async chooseEvaluationDatasetDirectory(mode: "read" | "write"): Promise<string | null> {
      // The titles deliberately avoid the word "import" before a quote: the CommonJS
      // shim electron-vite appends is placed after the last thing its regex reads as
      // a static import, and `to import", properties: ["` matches that shape closely
      // enough to get the shim spliced into the middle of this function.
      const dialogOptions: Electron.OpenDialogOptions = mode === "read"
        ? { title: "Choose the dataset folder to read", properties: ["openDirectory"] }
        : {
            title: "Choose where to write the dataset folder",
            properties: ["openDirectory", "createDirectory"],
          };
      const result = await showOpenDialog(dialogOptions);
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },

    // Writes a temporary file first so a failed write never leaves a partial export at the chosen path.
    async saveFromOwnerWindow(
      owner: number,
      bytes: Uint8Array,
      dialogOptions: Electron.SaveDialogOptions,
    ): Promise<boolean> {
      const parent = resolveOwnerWindow(owner);
      if (!parent) return false;
      const result = await dialog.showSaveDialog(parent, dialogOptions);
      if (result.canceled || !result.filePath || parent.isDestroyed()) return false;
      const temporary = path.join(path.dirname(result.filePath), `.agentrecall-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, result.filePath);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return true;
    },

    async confirmTeamOperation(owner: number, message: string): Promise<boolean> {
      const parent = resolveOwnerWindow(owner);
      if (!parent) return false;
      const result = await dialog.showMessageBox(parent, {
        type: "question",
        message: "确认团队操作",
        detail: message,
        buttons: ["取消", "确认"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 && !parent.isDestroyed();
    },

    async chooseFolderFromOwnerWindow(
      owner: number,
      dialogOptions: Electron.OpenDialogOptions,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const parent = resolveOwnerWindow(owner);
      if (!parent || signal?.aborted) return null;
      const result = await dialog.showOpenDialog(parent, dialogOptions);
      if (result.canceled || !result.filePaths[0] || parent.isDestroyed() || signal?.aborted) return null;
      return result.filePaths[0];
    },
  };
}
