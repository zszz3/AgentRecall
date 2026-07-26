import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { PackageSearch, X } from "lucide-react";
import type { RulesSyncSnapshot, AgentRule, RemoteRule, RestoreResult } from "../../../../core/rules-sync";
import type { MemoriesSyncSnapshot, AgentMemory, RemoteMemory } from "../../../../core/memories-sync";
import { assetIdentity } from "../../../../core/asset-identity";
import { localize, type LanguageMode } from "../../language";
import { AssetSyncTab, type LocalAssetItem, type RemoteAssetItem } from "./asset-sync-tab";
import type { SyncStatusKind } from "./sync-status-badge";

type DigitalAssetsTab = "rules" | "memories";

export function DigitalAssetsDialog({
  rulesSnapshot,
  memoriesSnapshot,
  language,
  onClose,
  onRulesUploadAll,
  onRulesUpload,
  onRulesDelete,
  onRulesCopySql,
  onRulesRestore,
  onMemoriesUploadAll,
  onMemoriesUpload,
  onMemoriesDelete,
  onMemoriesCopySql,
  onOpenSkills,
  onRefresh,
}: {
  rulesSnapshot: RulesSyncSnapshot | null;
  memoriesSnapshot: MemoriesSyncSnapshot | null;
  language: LanguageMode;
  onClose: () => void;
  onRulesUploadAll: () => Promise<{ uploaded: number; skipped: number }>;
  onRulesUpload: (identity: string) => Promise<unknown>;
  onRulesDelete: (remoteId: string) => Promise<boolean>;
  onRulesCopySql: () => void;
  onRulesRestore: () => Promise<RestoreResult>;
  onMemoriesUploadAll: () => Promise<{ uploaded: number; skipped: number }>;
  onMemoriesUpload: (identity: string) => Promise<unknown>;
  onMemoriesDelete: (remoteId: string) => Promise<boolean>;
  onMemoriesCopySql: () => void;
  onOpenSkills: () => void;
  onRefresh: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [activeTab, setActiveTab] = useState<DigitalAssetsTab>("rules");
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const showFeedback = useCallback((message: string) => {
    setFeedback(message);
    setTimeout(() => setFeedback(null), 4000);
  }, []);

  const handleRulesUploadAll = useCallback(async () => {
    setUploading(true);
    try {
      const result = await onRulesUploadAll();
      showFeedback(l(`Uploaded ${result.uploaded}, skipped ${result.skipped}`, `已上传 ${result.uploaded} 条，跳过 ${result.skipped} 条`));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onRulesUploadAll, onRefresh, showFeedback, l]);

  const handleRulesUpload = useCallback(async (identity: string) => {
    setUploading(true);
    try {
      await onRulesUpload(identity);
      showFeedback(l("Uploaded successfully", "上传成功"));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onRulesUpload, onRefresh, showFeedback, l]);

  const handleRulesDelete = useCallback(async (remoteId: string) => {
    setUploading(true);
    try {
      await onRulesDelete(remoteId);
      showFeedback(l("Deleted from remote", "已从远端删除"));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onRulesDelete, onRefresh, showFeedback, l]);

  const handleRulesRestore = useCallback(async () => {
    setUploading(true);
    try {
      const result = await onRulesRestore();
      showFeedback(l(
        `Restored ${result.restored.length}, skipped ${result.skipped.length}, backed up ${result.backedUp.length}`,
        `已还原 ${result.restored.length} 条，跳过 ${result.skipped.length} 条，备份 ${result.backedUp.length} 条`,
      ));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onRulesRestore, onRefresh, showFeedback, l]);

  const handleMemoriesUploadAll = useCallback(async () => {
    setUploading(true);
    try {
      const result = await onMemoriesUploadAll();
      showFeedback(l(`Uploaded ${result.uploaded}, skipped ${result.skipped}`, `已上传 ${result.uploaded} 条，跳过 ${result.skipped} 条`));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onMemoriesUploadAll, onRefresh, showFeedback, l]);

  const handleMemoriesUpload = useCallback(async (identity: string) => {
    setUploading(true);
    try {
      await onMemoriesUpload(identity);
      showFeedback(l("Uploaded successfully", "上传成功"));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onMemoriesUpload, onRefresh, showFeedback, l]);

  const handleMemoriesDelete = useCallback(async (remoteId: string) => {
    setUploading(true);
    try {
      await onMemoriesDelete(remoteId);
      showFeedback(l("Deleted from remote", "已从远端删除"));
      onRefresh();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }, [onMemoriesDelete, onRefresh, showFeedback, l]);

  const rulesLocalItems: LocalAssetItem[] = useMemo(() => {
    if (!rulesSnapshot) return [];
    return rulesSnapshot.localRules.map((rule: AgentRule) => ({
      identity: assetIdentity(rule),
      name: rule.name,
      scope: rule.scope,
      agent: rule.agent,
      contentHash: rule.contentHash,
      projectPath: rule.projectPath,
    }));
  }, [rulesSnapshot]);

  const rulesRemoteItems: RemoteAssetItem[] = useMemo(() => {
    if (!rulesSnapshot) return [];
    return rulesSnapshot.remoteRules.map((rule: RemoteRule) => ({
      id: rule.id,
      name: rule.name,
      scope: rule.scope,
      agent: rule.agent,
      content_hash: rule.content_hash,
      project_path: rule.project_path,
      updated_at: rule.updated_at,
    }));
  }, [rulesSnapshot]);

  const memoriesLocalItems: LocalAssetItem[] = useMemo(() => {
    if (!memoriesSnapshot) return [];
    return memoriesSnapshot.localMemories.map((memory: AgentMemory) => ({
      identity: assetIdentity(memory),
      name: memory.name,
      scope: memory.scope,
      agent: memory.agent,
      contentHash: memory.contentHash,
      projectPath: memory.projectPath,
    }));
  }, [memoriesSnapshot]);

  const memoriesRemoteItems: RemoteAssetItem[] = useMemo(() => {
    if (!memoriesSnapshot) return [];
    return memoriesSnapshot.remoteMemories.map((memory: RemoteMemory) => ({
      id: memory.id,
      name: memory.name,
      scope: memory.scope,
      agent: memory.agent,
      content_hash: memory.content_hash,
      project_path: memory.project_path,
      updated_at: memory.updated_at,
    }));
  }, [memoriesSnapshot]);

  const rulesStatus: SyncStatusKind = rulesSnapshot?.status.kind ?? "unconfigured";
  const memoriesStatus: SyncStatusKind = memoriesSnapshot?.status.kind ?? "unconfigured";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="command-dialog digital-assets-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          <h2>{l("Digital Assets", "数字资产")}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <nav className="digital-assets-tabs">
          <button
            className={`digital-assets-tab ${activeTab === "rules" ? "active" : ""}`}
            onClick={() => setActiveTab("rules")}
          >
            {l("Rules", "Rules 规则")}
            {rulesLocalItems.length > 0 ? <span className="tab-count">{rulesLocalItems.length}</span> : null}
          </button>
          <button
            className={`digital-assets-tab ${activeTab === "memories" ? "active" : ""}`}
            onClick={() => setActiveTab("memories")}
          >
            {l("Memories", "Memories 记忆")}
            {memoriesLocalItems.length > 0 ? <span className="tab-count">{memoriesLocalItems.length}</span> : null}
          </button>
          <button className="digital-assets-tab digital-assets-tab-skills" onClick={onOpenSkills}>
            <PackageSearch size={13} /> {l("Skills", "Skills")}
          </button>
        </nav>

        {feedback ? <div className="digital-assets-feedback">{feedback}</div> : null}

        <div className="digital-assets-content">
          {activeTab === "rules" ? (
            <AssetSyncTab
              title={l("Rules sync", "Rules 同步")}
              description={l(
                "Sync CLAUDE.md and .qoder/rules across devices.",
                "跨设备同步 CLAUDE.md 和 .qoder/rules 规则文件。",
              )}
              localItems={rulesLocalItems}
              remoteItems={rulesRemoteItems}
              status={rulesStatus}
              uploading={uploading}
              language={language}
              onUploadAll={handleRulesUploadAll}
              onUploadItem={handleRulesUpload}
              onDeleteRemote={handleRulesDelete}
              onCopySql={onRulesCopySql}
              onRestore={handleRulesRestore}
            />
          ) : (
            <AssetSyncTab
              title={l("Memories sync", "Memories 同步")}
              description={l(
                "Sync Qoder and Codex long-term memories across devices.",
                "跨设备同步 Qoder 和 Codex 长期记忆。",
              )}
              localItems={memoriesLocalItems}
              remoteItems={memoriesRemoteItems}
              status={memoriesStatus}
              uploading={uploading}
              language={language}
              onUploadAll={handleMemoriesUploadAll}
              onUploadItem={handleMemoriesUpload}
              onDeleteRemote={handleMemoriesDelete}
              onCopySql={onMemoriesCopySql}
            />
          )}
        </div>
      </div>
    </div>
  );
}
