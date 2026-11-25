import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ApiConfig, ClaudeApiConfig } from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../../../../core/session-sources";
import type { SessionEnvironment } from "../../../../core/types";
import type { V1ImportResult } from "../../../../core/v1-import";
import type { SessionSearchApi } from "../../../../preload";
import type { SettingsFeedback } from "../../app-types";
import { createLatestTaskQueue } from "../../latest-task-queue";
import { sourceFilters } from "../../session-ui";
import { errorText, showTransientSuccess } from "../status/status-messages";

type PendingSourceKey = (typeof OPTIONAL_SESSION_SOURCE_DESCRIPTORS)[number]["pendingKey"];

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  pendingKey: descriptor.pendingKey,
}));
const OPTIONAL_SOURCE_REFRESH_SETTLE_MS = 120;

function emptyPendingSources(): Record<PendingSourceKey, boolean> {
  return Object.fromEntries(
    OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map(({ pendingKey }) => [pendingKey, false]),
  ) as Record<PendingSourceKey, boolean>;
}

export interface AppSettingsController {
  settings: AppSettings | null;
  feedback: SettingsFeedback;
  /** Shared with other settings actions (environments, hooks) that report in the same place. */
  setFeedback: Dispatch<SetStateAction<SettingsFeedback>>;
  /** Source filters, revealing a newly enabled source only after its background load finished. */
  visibleSourceFilters: ReturnType<typeof sourceFilters>;
  update(update: AppSettingsUpdate): Promise<void>;
  importV1Data(): Promise<V1ImportResult>;
  applyCodexProfile(apiConfig: ApiConfig): Promise<void>;
  applyClaudeProfile(apiConfig: ClaudeApiConfig): Promise<void>;
}

interface AppSettingsOptions {
  api: Pick<
    SessionSearchApi,
    "getSettings" | "setSettings" | "refreshIndex" | "importV1Data" | "listEnvironments" | "applyCodexProfile" | "applyClaudeProfile"
  > & Partial<Pick<SessionSearchApi, "onIslandSnapshot">>;
  /** Reloads the Session list, sidebar and stats after the set of sources changed. */
  reloadSessions(): Promise<void>;
  setEnvironments(environments: SessionEnvironment[]): void;
  invalidateRemoteSessions(): void;
  refreshSessionHookStatus(): void;
  loadQuotas(): Promise<void>;
  t(en: string, zh: string): string;
}

/**
 * Owns the app settings: the loaded value, the shared settings feedback, saving
 * updates one at a time, and loading Sessions of a source in the background
 * after it was turned on or off.
 */
export function useAppSettings(options: AppSettingsOptions): AppSettingsController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedback>(null);
  const [pendingSources, setPendingSources] = useState(emptyPendingSources);
  const settingsRef = useRef<AppSettings | null>(null);
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshGenerationRef = useRef(0);
  const indexRefreshKeysRef = useRef(new Set<PendingSourceKey>());
  const [refreshQueue] = useState(() => createLatestTaskQueue<void>({ settleMs: OPTIONAL_SOURCE_REFRESH_SETTLE_MS }));
  settingsRef.current = settings;

  useEffect(() => {
    void optionsRef.current.api.getSettings().then(setSettings);
    const offIsland = optionsRef.current.api.onIslandSnapshot?.((snapshot) => {
      setSettings((current) => (current && current.islandEnabled !== snapshot.enabled
        ? { ...current, islandEnabled: snapshot.enabled }
        : current));
    });
    return () => {
      offIsland?.();
    };
  }, []);

  const replaceSettings = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const scheduleSourceRefresh = useCallback(() => {
    const { t } = optionsRef.current;
    refreshGenerationRef.current += 1;
    setFeedback({ kind: "success", message: t("Loading sessions in the background...", "正在后台加载会话...") });
    void refreshQueue.request(async () => {
      const { api, reloadSessions, t: translate } = optionsRef.current;
      const generation = refreshGenerationRef.current;
      const shouldRefreshIndex = indexRefreshKeysRef.current.size > 0;
      indexRefreshKeysRef.current.clear();
      try {
        if (shouldRefreshIndex) {
          const status = await api.refreshIndex();
          if (status.error) throw new Error(status.error);
        }
        await reloadSessions();
        // A later source change started a newer load; its result decides what is shown.
        if (refreshGenerationRef.current !== generation) return;
        setPendingSources(emptyPendingSources());
        showTransientSuccess(setFeedback, translate("Sources ready.", "来源已就绪。"), 1600);
      } catch (error) {
        if (refreshGenerationRef.current !== generation) return;
        setPendingSources(emptyPendingSources());
        setFeedback({ kind: "error", message: errorText(error) });
      }
    }).catch(() => undefined);
  }, [refreshQueue]);

  const performUpdate = useCallback(async (next: AppSettingsUpdate): Promise<void> => {
    const { api, invalidateRemoteSessions, refreshSessionHookStatus, loadQuotas, t } = optionsRef.current;
    const current = settingsRef.current;
    const changedSources = OPTIONAL_SOURCE_SETTINGS.filter((item) => item.key in next && next[item.key] !== current?.[item.key]);
    const quotaVisibilityChanged =
      ("hideCodexQuota" in next && next.hideCodexQuota !== current?.hideCodexQuota) ||
      ("hideClaudeQuota" in next && next.hideClaudeQuota !== current?.hideClaudeQuota);
    const remoteSyncConfigurationChanged =
      ("remoteSyncEnabled" in next && next.remoteSyncEnabled !== current?.remoteSyncEnabled) ||
      ("remoteSyncSupabaseUrl" in next && next.remoteSyncSupabaseUrl !== current?.remoteSyncSupabaseUrl) ||
      ("remoteSyncSupabaseAnonKey" in next && next.remoteSyncSupabaseAnonKey !== current?.remoteSyncSupabaseAnonKey);
    setFeedback({ kind: "running", message: t("Saving settings...", "正在保存设置...") });
    try {
      const nextSettings = await api.setSettings(next);
      replaceSettings(nextSettings);
      if (remoteSyncConfigurationChanged) invalidateRemoteSessions();
      if ("remoteSyncEnabled" in next) refreshSessionHookStatus();
      if (quotaVisibilityChanged) void loadQuotas();

      if (changedSources.length > 0) {
        setPendingSources((pending) => {
          const nextPending = { ...pending };
          for (const item of changedSources) nextPending[item.pendingKey] = nextSettings[item.key];
          return nextPending;
        });
        for (const item of changedSources) {
          if (nextSettings[item.key]) indexRefreshKeysRef.current.add(item.pendingKey);
          else indexRefreshKeysRef.current.delete(item.pendingKey);
        }
        scheduleSourceRefresh();
        return;
      }
      setFeedback({ kind: "success", message: t("Settings saved.", "设置已保存。") });
      window.setTimeout(() => {
        setFeedback((shown) => (shown?.kind === "success" ? null : shown));
      }, 1600);
    } catch (error) {
      setFeedback({ kind: "error", message: errorText(error) });
    }
  }, [replaceSettings, scheduleSourceRefresh]);

  const update = useCallback((next: AppSettingsUpdate): Promise<void> => {
    const request = updateQueueRef.current.then(() => performUpdate(next));
    updateQueueRef.current = request.catch(() => undefined);
    return request;
  }, [performUpdate]);

  const importV1Data = useCallback(async (): Promise<V1ImportResult> => {
    const { api, reloadSessions, setEnvironments, invalidateRemoteSessions, refreshSessionHookStatus } = optionsRef.current;
    const result = await api.importV1Data();
    const [nextSettings, nextEnvironments] = await Promise.all([
      api.getSettings(),
      api.listEnvironments(),
      reloadSessions(),
    ]);
    replaceSettings(nextSettings);
    setEnvironments(nextEnvironments);
    invalidateRemoteSessions();
    refreshSessionHookStatus();
    return result;
  }, [replaceSettings]);

  const applyProfile = useCallback(async (
    runningMessage: string,
    apply: () => Promise<{ settings: AppSettingsUpdate; successMessage: string }>,
  ): Promise<void> => {
    const { api, t } = optionsRef.current;
    setFeedback({ kind: "running", message: runningMessage });
    try {
      const applied = await apply();
      const nextSettings = await api.setSettings(applied.settings).catch((error: unknown) => {
        throw new Error(t("Client configuration was written, but saving app settings failed: ", "客户端配置已写入，但应用设置保存失败：") + errorText(error));
      });
      replaceSettings(nextSettings);
      const { successMessage } = applied;
      setFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setFeedback((shown) => (shown?.kind === "success" && shown.message === successMessage ? null : shown));
      }, 2200);
    } catch (error) {
      setFeedback({ kind: "error", message: errorText(error) });
      throw error;
    }
  }, [replaceSettings]);

  const applyCodexProfile = useCallback((apiConfig: ApiConfig): Promise<void> => {
    const { api, t } = optionsRef.current;
    return applyProfile(t("Applying Codex profile...", "正在应用 Codex 配置..."), async () => {
      const result = await api.applyCodexProfile(apiConfig);
      const profileLabel = result.profile === "codex" ? "Codex Official" : apiConfig.customProviderName.trim() || "CodexZH";
      const usesLocalProxy = apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
      return {
        settings: { apiConfig },
        successMessage: usesLocalProxy
          ? t(
              `Applied and verified ${profileLabel} at ${result.configTarget} via local proxy.`,
              `已通过本地 proxy 将 ${profileLabel} 写入并验证：${result.configTarget}`,
            )
          : t(
              `Applied and verified ${profileLabel} at ${result.configTarget}.`,
              `已将 ${profileLabel} 写入并验证：${result.configTarget}`,
            ),
      };
    });
  }, [applyProfile]);

  const applyClaudeProfile = useCallback((claudeApiConfig: ClaudeApiConfig): Promise<void> => {
    const { api, t } = optionsRef.current;
    return applyProfile(t("Applying Claude Code profile...", "正在应用 Claude Code 配置..."), async () => {
      const result = await api.applyClaudeProfile(claudeApiConfig);
      const profileLabel =
        result.profile === "claude-official" ? "Claude Official" : claudeApiConfig.customProviderName.trim() || "Claude Code";
      return {
        settings: { claudeApiConfig },
        successMessage: t(
          `Applied and verified ${profileLabel} at ${result.settingsPath}.`,
          `已将 ${profileLabel} 写入并验证：${result.settingsPath}`,
        ),
      };
    });
  }, [applyProfile]);

  const visibleSourceFilters = useMemo(() => {
    if (!settings) return sourceFilters(null);
    const visibleSettings = { ...settings };
    for (const descriptor of OPTIONAL_SESSION_SOURCE_DESCRIPTORS) {
      visibleSettings[descriptor.optionalSetting] =
        settings[descriptor.optionalSetting] && !pendingSources[descriptor.pendingKey];
    }
    return sourceFilters(visibleSettings);
  }, [settings, pendingSources]);

  return {
    settings,
    feedback,
    setFeedback,
    visibleSourceFilters,
    update,
    importV1Data,
    applyCodexProfile,
    applyClaudeProfile,
  };
}
