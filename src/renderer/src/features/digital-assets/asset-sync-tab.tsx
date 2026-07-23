import type { ReactElement } from "react";
import { Copy, Download, Trash2, Upload } from "lucide-react";
import { localize, type LanguageMode } from "../../language";
import { AssetSyncIcon, SyncStatusBadge, type AssetSyncState, type SyncStatusKind } from "./sync-status-badge";

export interface LocalAssetItem {
  identity: string;
  name: string;
  scope: string;
  agent: string;
  contentHash: string;
  projectPath: string;
}

export interface RemoteAssetItem {
  id: string;
  name: string;
  scope: string;
  agent: string;
  content_hash: string;
  project_path: string;
  updated_at: string;
}

export function computeSyncState(local: LocalAssetItem, remoteItems: RemoteAssetItem[]): AssetSyncState {
  const remote = remoteItems.find(
    (r) => r.agent === local.agent && r.scope === local.scope && r.name === local.name && r.project_path === local.projectPath,
  );
  if (!remote) return "new";
  return remote.content_hash === local.contentHash ? "synced" : "modified";
}

export function AssetSyncTab({
  title,
  description,
  localItems,
  remoteItems,
  status,
  uploading,
  language,
  onUploadAll,
  onUploadItem,
  onDeleteRemote,
  onCopySql,
  onRestore,
}: {
  title: string;
  description: string;
  localItems: LocalAssetItem[];
  remoteItems: RemoteAssetItem[];
  status: SyncStatusKind;
  uploading: boolean;
  language: LanguageMode;
  onUploadAll: () => void;
  onUploadItem: (identity: string) => void;
  onDeleteRemote: (remoteId: string) => void;
  onCopySql: () => void;
  onRestore?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const syncedCount = localItems.filter((item) => computeSyncState(item, remoteItems) === "synced").length;
  const modifiedCount = localItems.filter((item) => computeSyncState(item, remoteItems) === "modified").length;
  const newCount = localItems.filter((item) => computeSyncState(item, remoteItems) === "new").length;

  return (
    <div className="asset-sync-tab">
      <header className="asset-sync-header">
        <div className="asset-sync-header-left">
          <h3>{title}</h3>
          <p className="asset-sync-description">{description}</p>
        </div>
        <div className="asset-sync-header-right">
          <SyncStatusBadge status={status} language={language} />
          <button className="asset-action-button" onClick={onUploadAll} disabled={uploading || status !== "ready"}>
            <Upload size={13} /> {l("Upload All", "全部上传")}
          </button>
          {onRestore ? (
            <button className="asset-action-button" onClick={onRestore} disabled={uploading || status !== "ready" || remoteItems.length === 0}>
              <Download size={13} /> {l("Restore", "还原")}
            </button>
          ) : null}
          <button className="asset-action-button" onClick={onCopySql} title={l("Copy Supabase setup SQL", "复制 Supabase 建表 SQL")}>
            <Copy size={13} /> SQL
          </button>
        </div>
      </header>

      <div className="asset-sync-summary">
        <span className="asset-summary-item asset-summary-synced">{l(`${syncedCount} synced`, `${syncedCount} 已同步`)}</span>
        <span className="asset-summary-item asset-summary-modified">{l(`${modifiedCount} modified`, `${modifiedCount} 已修改`)}</span>
        <span className="asset-summary-item asset-summary-new">{l(`${newCount} not synced`, `${newCount} 未同步`)}</span>
        <span className="asset-summary-item">{l(`${localItems.length} local`, `${localItems.length} 本地`)}</span>
        <span className="asset-summary-item">{l(`${remoteItems.length} remote`, `${remoteItems.length} 远端`)}</span>
      </div>

      <section className="asset-section">
        <h4>{l("Local assets", "本地资产")}</h4>
        {localItems.length === 0 ? (
          <p className="asset-empty">{l("No local assets found.", "未找到本地资产。")}</p>
        ) : (
          <div className="asset-table-wrap">
            <table className="asset-table">
              <thead>
                <tr>
                  <th>{l("Name", "名称")}</th>
                  <th>{l("Scope", "范围")}</th>
                  <th>{l("Agent", "平台")}</th>
                  <th>{l("Status", "状态")}</th>
                  <th>{l("Action", "操作")}</th>
                </tr>
              </thead>
              <tbody>
                {localItems.map((item) => {
                  const syncState = computeSyncState(item, remoteItems);
                  return (
                    <tr key={item.identity}>
                      <td className="asset-name-cell" title={item.projectPath ? `${item.projectPath}/${item.name}` : item.name}>
                        {item.name}
                      </td>
                      <td>{item.scope === "global" ? l("Global", "全局") : item.projectPath || item.scope}</td>
                      <td>{item.agent}</td>
                      <td><AssetSyncIcon state={syncState} language={language} /></td>
                      <td>
                        {syncState !== "synced" ? (
                          <button
                            className="asset-row-action"
                            onClick={() => onUploadItem(item.identity)}
                            disabled={uploading || status !== "ready"}
                            title={l("Upload", "上传")}
                          >
                            <Upload size={12} />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="asset-section">
        <h4>{l("Remote assets", "远端资产")}</h4>
        {remoteItems.length === 0 ? (
          <p className="asset-empty">{l("No remote assets.", "暂无远端资产。")}</p>
        ) : (
          <div className="asset-table-wrap">
            <table className="asset-table">
              <thead>
                <tr>
                  <th>{l("Name", "名称")}</th>
                  <th>{l("Scope", "范围")}</th>
                  <th>{l("Agent", "平台")}</th>
                  <th>{l("Updated", "更新时间")}</th>
                  <th>{l("Action", "操作")}</th>
                </tr>
              </thead>
              <tbody>
                {remoteItems.map((item) => (
                  <tr key={item.id}>
                    <td className="asset-name-cell" title={item.project_path ? `${item.project_path}/${item.name}` : item.name}>
                      {item.name}
                    </td>
                    <td>{item.scope === "global" ? l("Global", "全局") : item.project_path || item.scope}</td>
                    <td>{item.agent}</td>
                    <td className="asset-date-cell">{formatRemoteDate(item.updated_at)}</td>
                    <td>
                      <button
                        className="asset-row-action asset-row-action-danger"
                        onClick={() => onDeleteRemote(item.id)}
                        disabled={uploading || status !== "ready"}
                        title={l("Delete from remote", "从远端删除")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function formatRemoteDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
