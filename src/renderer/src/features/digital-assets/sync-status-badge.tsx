import type { ReactElement } from "react";
import { localize, type LanguageMode } from "../../language";

export type SyncStatusKind = "ready" | "missing-table" | "error" | "unconfigured";

export function SyncStatusBadge({ status, language }: { status: SyncStatusKind; language: LanguageMode }): ReactElement {
  const config: Record<SyncStatusKind, { className: string; label: string }> = {
    ready: { className: "sync-badge sync-badge-ready", label: localize(language, "Connected", "已连接") },
    "missing-table": { className: "sync-badge sync-badge-warning", label: localize(language, "Table missing", "表未创建") },
    error: { className: "sync-badge sync-badge-error", label: localize(language, "Error", "错误") },
    unconfigured: { className: "sync-badge sync-badge-off", label: localize(language, "Not configured", "未配置") },
  };
  const { className, label } = config[status];
  return <span className={className}>{label}</span>;
}

export type AssetSyncState = "synced" | "modified" | "new";

export function AssetSyncIcon({ state, language }: { state: AssetSyncState; language: LanguageMode }): ReactElement {
  const config: Record<AssetSyncState, { className: string; label: string; symbol: string }> = {
    synced: { className: "asset-sync-icon asset-sync-synced", label: localize(language, "Synced", "已同步"), symbol: "✓" },
    modified: { className: "asset-sync-icon asset-sync-modified", label: localize(language, "Modified", "已修改"), symbol: "↑" },
    new: { className: "asset-sync-icon asset-sync-new", label: localize(language, "Not synced", "未同步"), symbol: "○" },
  };
  const { className, label, symbol } = config[state];
  return (
    <span className={className} title={label}>
      {symbol}
    </span>
  );
}
