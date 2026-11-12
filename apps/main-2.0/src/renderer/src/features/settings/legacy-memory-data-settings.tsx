import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";

import type { LegacyMemoryDataStatus } from "../../../../shared/ipc/legacy-memory-data";
import { localize, type LanguageMode } from "../../language";

/**
 * Offers to delete the data the retired directory Memory feature left on disk.
 * Renders nothing unless that data exists; deletion runs in the main process.
 */
export function LegacyMemoryDataSettings({ language }: { language: LanguageMode }): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [status, setStatus] = useState<LegacyMemoryDataStatus | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.sessionSearch.getLegacyMemoryDataStatus());
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  if (!status?.present && !error) return null;

  const remove = async (): Promise<void> => {
    if (removing) return;
    if (!window.confirm(l(
      "Delete the old memory data? This permanently removes the retired directory Memory runtime, models and memories from this device.",
      "删除旧记忆数据？将从本机永久删除已停用的目录 Memory 运行组件、模型和记忆内容，无法恢复。",
    ))) return;
    setRemoving(true);
    setError(null);
    try {
      setStatus(await window.sessionSearch.removeLegacyMemoryData());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="settings-field">
      <div className="settings-field-text">
        <span className="settings-field-title">{l("Old memory data", "旧记忆数据")}</span>
        <span className="settings-field-sub">
          {status?.present
            ? l(
              `Directory Memory has been removed. Its data still uses ${formatSize(status.sizeBytes)} on this device.`,
              `目录 Memory 已移除，其数据仍占用本机 ${formatSize(status.sizeBytes)}。`,
            )
            : l("Could not read the old memory data.", "无法读取旧记忆数据。")}
        </span>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
      {status?.present ? (
        <button
          type="button"
          className="settings-action-button"
          disabled={removing}
          onClick={() => void remove()}
        >
          <Trash2 size={14} /> {removing ? l("Deleting...", "删除中...") : l("Delete", "删除")}
        </button>
      ) : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
