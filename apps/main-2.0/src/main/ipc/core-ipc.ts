import { clipboard, shell, type IpcMainInvokeEvent } from "electron";
import * as fs from "node:fs/promises";
import type { AiChatMessage } from "../../core/ai-assistant";
import { normalizeExternalLink } from "../../core/external-link";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { RemoteEnvironmentLifecycle } from "../../core/remote-environment-lifecycle";
import { diagnoseRemoteEnvironment } from "../../core/remote-health";
import type { SessionStore } from "../../core/session-store";
import { readUserSshConfig } from "../../core/ssh-config";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "../../core/supabase-setup";
import type {
  EnvironmentUpsertInput,
  SessionEnvironment,
  SessionMigrationRequest,
} from "../../core/types";
import { listWslDistributionDetails, listWslDistributions } from "../../core/wsl";
import type { ProviderService } from "../services/provider-service";
import type { RemoteSessionAccess } from "../services/remote-session-access";
import type { SessionMigrationCoordinator } from "../services/remote-session-migration";
import type { SessionAiService } from "../services/session-ai-service";
import { V1SessionImportService } from "../services/v1-session-import-service";
import { combineIpcDisposers, type IpcMainRegistrar } from "./register-ipc-handler";

function registerRawChannel<Args extends unknown[]>(
  ipc: IpcMainRegistrar,
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
): () => void {
  ipc.handle(channel, (event, ...args) => handler(event, ...(args as Args)));
  return () => ipc.removeHandler(channel);
}

export interface CoreIpcDependencies {
  store: SessionStore;
  providerService: ProviderService;
  remoteSessionAccess: RemoteSessionAccess;
  sessionAiService: SessionAiService;
  sessionMigration: SessionMigrationCoordinator;
  ensureRemoteEnvironmentLifecycle: () => RemoteEnvironmentLifecycle;
  runSshHealthCommand: (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;
  getSettings: () => AppSettings;
  applySettingsUpdate: (settings: AppSettingsUpdate) => Promise<AppSettings>;
  setInterfaceZoom: (factor: unknown) => number;
  refreshApplicationMenuZoom: () => void;
  openQuickSearchSession: (sessionKey: string) => Promise<void>;
  appDataPath: string;
  userDataPath: string;
  emitEnvironmentsUpdated: () => void;
}

export function registerCoreIpc(
  ipc: IpcMainRegistrar,
  deps: CoreIpcDependencies,
): () => void {
  return combineIpcDisposers([
    registerRawChannel(ipc, "markdown:open-external", (_event, value: unknown) => {
      const url = normalizeExternalLink(value);
      if (!url) throw new Error("Only HTTP, HTTPS, and mailto links can be opened externally.");
      return shell.openExternal(url);
    }),

    registerRawChannel(ipc, "attachment:preview", async (_event, sessionKey: string, attachmentId: string) => {
      const attachment = await deps.store.getAttachmentFile(sessionKey, attachmentId);
      if (!attachment) throw new Error("Attachment is unavailable.");
      if (attachment.previewKind === "image") {
        const bytes = await fs.readFile(attachment.cachePath);
        return { kind: "image", data: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
      }
      if (attachment.previewKind === "text") {
        const text = await fs.readFile(attachment.cachePath, "utf8");
        return { kind: "text", data: text.slice(0, 256 * 1024) };
      }
      const error = await shell.openPath(attachment.cachePath);
      if (error) throw new Error(error);
      return { kind: "external" };
    }),

    registerRawChannel(ipc, "attachment:open", async (_event, sessionKey: string, attachmentId: string) => {
      const attachment = await deps.store.getAttachmentFile(sessionKey, attachmentId);
      if (!attachment) throw new Error("Attachment is unavailable.");
      const error = await shell.openPath(attachment.cachePath);
      if (error) throw new Error(error);
    }),

    registerRawChannel(ipc, "session:summarize", (_event, sessionKey: string) =>
      deps.sessionAiService.summarizeSession(sessionKey),
    ),

    registerRawChannel(ipc, "session:summarize-missing", (event) =>
      deps.sessionAiService.summarizeMissingSessions((progress) => {
        try {
          event.sender.send("summary:progress", progress);
        } catch {
          // The window can be destroyed mid-batch; progress delivery must not abort it.
        }
      }),
    ),

    registerRawChannel(ipc, "ai:assistant-chat", (_event, messages: AiChatMessage[]) =>
      deps.sessionAiService.runAssistantChat(messages),
    ),

    registerRawChannel(ipc, "ssh-config:list-hosts", () => readUserSshConfig()),
    registerRawChannel(ipc, "wsl:list-distributions", () => listWslDistributions()),
    registerRawChannel(ipc, "wsl:list-distribution-details", () => listWslDistributionDetails()),

    registerRawChannel(ipc, "environment:save", (_event, input: EnvironmentUpsertInput) =>
      deps.ensureRemoteEnvironmentLifecycle().saveEnvironment(input),
    ),
    registerRawChannel(ipc, "environment:delete", (_event, environmentId: string) =>
      deps.ensureRemoteEnvironmentLifecycle().deleteEnvironment(environmentId),
    ),
    registerRawChannel(ipc, "environment:refresh", (_event, environmentId: string) =>
      deps.ensureRemoteEnvironmentLifecycle().refreshEnvironment(environmentId),
    ),
    registerRawChannel(ipc, "environment:diagnose", async (_event, environmentId: string) => {
      const environment = await deps.store.getEnvironment(environmentId);
      if (environment?.kind === "wsl") return diagnoseRemoteEnvironment(environment);
      return diagnoseRemoteEnvironment(
        await deps.remoteSessionAccess.requireSshEnvironment(environmentId),
        { runSsh: deps.runSshHealthCommand },
      );
    }),

    registerRawChannel(ipc, "quick-search:open-session", (_event, sessionKey: string) =>
      deps.openQuickSearchSession(sessionKey),
    ),

    registerRawChannel(ipc, "settings:get", () => deps.providerService.hydrateSettings()),
    registerRawChannel(ipc, "settings:set", (_event, settings: AppSettingsUpdate) =>
      deps.applySettingsUpdate(settings),
    ),

    registerRawChannel(ipc, "interface-zoom:set", (_event, factor: unknown) => {
      const result = deps.setInterfaceZoom(factor);
      deps.refreshApplicationMenuZoom();
      return result;
    }),

    registerRawChannel(ipc, "v1-import:run", async () => {
      const result = await new V1SessionImportService({
        store: deps.store,
        appDataPath: deps.appDataPath,
        v2UserDataPath: deps.userDataPath,
        applySettings: async (update) => {
          await deps.applySettingsUpdate(update);
        },
      }).importData();
      deps.emitEnvironmentsUpdated();
      return result;
    }),

    registerRawChannel(ipc, "supabase:copy-combined-setup-sql", () => {
      clipboard.writeText(buildCombinedSupabaseSetupSql());
    }),

    registerRawChannel(ipc, "supabase:open-sql-editor", (_event, target: unknown) => {
      const settings = deps.getSettings();
      const projectUrl = target === "skills" ? settings.skillSyncSupabaseUrl : settings.remoteSyncSupabaseUrl;
      return shell.openExternal(supabaseSqlEditorUrl(projectUrl));
    }),

    registerRawChannel(ipc, "session:migrate", (event, request: SessionMigrationRequest) =>
      deps.sessionMigration.migrateSession(request, (progress) => {
        event.sender.send("session:migration-progress", progress);
      }),
    ),
  ]);
}
