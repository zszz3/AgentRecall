import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { X } from "lucide-react";
import { WorkflowHistoryPanel } from "../../../../automation/engine/renderer/src/pages/workflow/WorkflowHistoryPanel";
import { WorkflowPage } from "../../../../automation/engine/renderer/src/pages/workflow/WorkflowPage";
import { useWorkflowFeatureManager } from "../../../../automation/engine/renderer/src/pages/workflow/hooks/useWorkflowFeatureManager";
import { workflowService } from "../../../../automation/engine/renderer/src/app/services/workflow-service";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation, useAutomationStoreSnapshot } from "./automation-provider";
import type { WorkflowImportPreview } from "../../../../automation/contracts";

export function WorkflowFeaturePage({ language }: { language: LanguageMode }): ReactElement {
  const { api, setSnapshot, loading, error, refresh } = useAutomation();
  const snapshot = useAutomationStoreSnapshot();
  const snapshotRef = useRef(snapshot);
  const workflows = useMemo(() => workflowService(), []);
  const [importPreview, setImportPreview] = useState<WorkflowImportPreview | undefined>();
  const [portableBusy, setPortableBusy] = useState(false);
  const [agentMappings, setAgentMappings] = useState<Record<string, string>>({});
  const [modelMappings, setModelMappings] = useState<Record<string, string>>({});
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  const manager = useWorkflowFeatureManager({
    workflows,
    snapshot,
    snapshotRef,
    setSnapshot,
    language,
    onChooseWorkDir: async () => setSnapshot(await api.chooseWorkDir()),
    onRefresh: async () => { await refresh(); },
    onReadOutputFile: api.readLocalFile,
    onResolveRuntimeApproval: async (ownerId, requestId, decision) => {
      setSnapshot(await api.resolveRuntimeApproval({ ownerId, requestId, decision }));
    },
  });
  const sidebar = manager.sidebarController;

  return (
    <div className="automation-page automation-workflow-page" data-page="workflows" onClick={manager.closeSidebarContextMenu}>
      <header className="app-page-head automation-page-head">
        <div>
          <h2>Workflow</h2>
          <p>{localize(language, "Design, review, run, and intervene in reusable Agent workflows.", "设计、审核、运行并干预可复用的 Agent 工作流。")}</p>
        </div>
      </header>
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <div className="automation-workflow-shell">
          <WorkflowHistoryPanel
            workflows={sidebar.workflows}
            activeWorkflowId={sidebar.activeWorkflowId}
            running={sidebar.running}
            contextMenu={sidebar.contextMenu}
            renameDraft={sidebar.renameDraft}
            readinessByWorkflowId={snapshot.workflowStore.readinessByWorkflowId}
            portableBusy={portableBusy}
            onNewWorkflow={sidebar.onNewWorkflow}
            onImportWorkflow={async () => {
              try {
                setPortableBusy(true);
                const preview = await workflows.beginImport();
                setAgentMappings({});
                setModelMappings({});
                setImportPreview(preview);
              } catch (cause) {
                window.alert(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setPortableBusy(false);
              }
            }}
            onSelectWorkflow={sidebar.onSelectWorkflow}
            onOpenContextMenu={(event, workflowId) => {
              event.preventDefault();
              event.stopPropagation();
              sidebar.onOpenContextMenu?.(workflowId, event.clientX, event.clientY);
            }}
            onStartRename={sidebar.onStartRename}
            onRenameDraftChange={sidebar.onRenameDraftChange}
            onConfirmRename={sidebar.onConfirmRename}
            onCancelRename={sidebar.onCancelRename}
            onDeleteWorkflow={sidebar.onDeleteWorkflow}
            onCloneWorkflow={async (workflowId) => {
              try {
                setPortableBusy(true);
                setSnapshot(await workflows.cloneOfficialWorkflow(workflowId));
                manager.closeSidebarContextMenu();
              } catch (cause) {
                window.alert(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setPortableBusy(false);
              }
            }}
            onExportWorkflow={async (workflowId) => {
              try {
                setPortableBusy(true);
                const result = await workflows.exportWorkflow(workflowId);
                manager.closeSidebarContextMenu();
                if (result.status === "exported") {
                  const secretNotice = result.removedSecretValueCount
                    ? ` ${result.removedSecretValueCount} secret value(s) were removed.`
                    : "";
                  window.alert(`Workflow exported as ${result.fileName}.${secretNotice}`);
                }
              } catch (cause) {
                window.alert(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setPortableBusy(false);
              }
            }}
          />
          <section className="automation-workflow-detail" onClick={(event) => event.stopPropagation()}>
            {(() => {
              const active = snapshot.workflowStore.workflows.find((workflow) => workflow.workflowId === snapshot.workflowStore.activeWorkflowId);
              const readiness = active ? snapshot.workflowStore.readinessByWorkflowId?.[active.workflowId] : undefined;
              if (!active || (!active.origin && readiness?.ready !== false)) return null;
              return <aside className="workflow-portable-status">
                {active.origin?.importedFrom ? <p>Imported from <strong>{active.origin.importedFrom.fileName}</strong> (source rev {active.origin.importedFrom.revision}).</p> : null}
                {active.origin?.rootOrigin ? <p>{active.origin.rootOrigin.trust === "catalog" ? "Cloned from official workflow" : "File-declared origin (not officially verified)"}: <strong>{active.origin.rootOrigin.title}</strong> rev {active.origin.rootOrigin.revision}.</p> : null}
                {readiness?.ready === false ? <div><strong>待配置</strong>{readiness.issues.map((issue) => <p key={`${issue.code}:${issue.scope}:${issue.nodeId ?? ""}:${issue.field}`}>{issue.message}</p>)}</div> : null}
              </aside>;
            })()}
            <WorkflowPage controller={manager.controller} />
          </section>
        </div>
      </AutomationPageState>
      {importPreview ? (
        <section className="workflow-rename-overlay" role="dialog" aria-modal="true" aria-label="Import workflow preview">
          <div className="workflow-rename-modal workflow-import-preview" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Import workflow</strong>
              <button type="button" className="icon-btn" disabled={portableBusy} aria-label="Close import preview" onClick={() => {
                void workflows.cancelImport(importPreview.previewToken);
                setImportPreview(undefined);
              }}><X size={14} /></button>
            </header>
            <div className="workflow-import-preview-body">
              <p><strong>{importPreview.title}</strong></p>
              <p>{importPreview.fileName} · schema {importPreview.schemaVersion} · source {importPreview.sourceWorkflowId} · rev {importPreview.sourceRevision}</p>
              <p>{importPreview.nodeCount} nodes · {importPreview.edgeCount} edges</p>
              <p>{importPreview.objective}</p>
              {importPreview.removedSecretValueCount > 0 ? <p role="status">{importPreview.removedSecretValueCount} secret value(s) will be removed before import.</p> : null}
              {importPreview.scripts.length > 0 ? <div><p>{importPreview.scripts.length} script node(s) will continue to use normal runtime approval rules.</p>{importPreview.scripts.map((script) => <p key={script.nodeId}>{script.title}: {script.effectiveRisk}{script.capabilities.length ? ` · ${script.capabilities.join(", ")}` : ""}{script.uncertain ? " · risk uncertain" : ""}</p>)}</div> : null}
              {importPreview.rootOrigin ? <p>File-declared official origin (not officially verified): {importPreview.rootOrigin.title} rev {importPreview.rootOrigin.revision}.</p> : null}
              {importPreview.readiness.issues.length > 0 ? <section className="workflow-import-mappings"><strong>Dependencies</strong>{importPreview.readiness.issues.map((issue, index) => {
                const key = `${issue.code}:${issue.scope}:${issue.nodeId ?? ""}:${issue.field}:${index}`;
                if (issue.code === "AGENT_MISSING" && issue.configuredAgentId) return <label key={key}>{issue.message}<select value={agentMappings[issue.configuredAgentId] ?? ""} onChange={(event) => setAgentMappings((current) => ({ ...current, [issue.configuredAgentId!]: event.currentTarget.value }))}><option value="">Keep unresolved</option>{snapshot.configuredAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.id})</option>)}</select></label>;
                if (issue.code === "MODEL_UNAVAILABLE" && issue.configuredAgentId && issue.modelId) {
                  const agentId = agentMappings[issue.configuredAgentId] ?? issue.configuredAgentId;
                  const agent = snapshot.configuredAgents.find((candidate) => candidate.id === agentId);
                  const channel = snapshot.channels.find((candidate) => candidate.id === agent?.channelId);
                  const mappingKey = `${issue.configuredAgentId}\u0000${issue.modelId}`;
                  return <label key={key}>{issue.message}<select value={modelMappings[mappingKey] ?? ""} onChange={(event) => setModelMappings((current) => ({ ...current, [mappingKey]: event.currentTarget.value }))}><option value="">Keep unresolved</option>{(channel?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>;
                }
                return <p key={key}>{issue.message}</p>;
              })}</section> : <p>All referenced Agents, models, tools, and required Secret inputs are ready on this device.</p>}
              {importPreview.definitionWarnings.map((warning) => <p key={warning} className="workflow-transaction-compatibility-warning">{warning}</p>)}
              {importPreview.definitionErrors.map((problem) => <p key={problem} className="error-text">{problem}</p>)}
            </div>
            <footer>
              <button type="button" className="control-btn compact" disabled={portableBusy} onClick={() => {
                void workflows.cancelImport(importPreview.previewToken);
                setImportPreview(undefined);
              }}>Cancel</button>
              <button type="button" className="send-btn compact" disabled={portableBusy || importPreview.definitionErrors.length > 0} onClick={async () => {
                try {
                  setPortableBusy(true);
                  setSnapshot(await workflows.confirmImport({ previewToken: importPreview.previewToken, agentMappings, modelMappings }));
                  setImportPreview(undefined);
                } catch (cause) {
                  window.alert(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setPortableBusy(false);
                }
              }}>Import as copy</button>
            </footer>
          </div>
        </section>
      ) : null}
    </div>
  );
}
