import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { WorkflowHistoryPanel } from "../../../../automation/engine/renderer/src/pages/workflow/WorkflowHistoryPanel";
import { WorkflowPage } from "../../../../automation/engine/renderer/src/pages/workflow/WorkflowPage";
import { useWorkflowFeatureManager } from "../../../../automation/engine/renderer/src/pages/workflow/hooks/useWorkflowFeatureManager";
import { workflowService } from "../../../../automation/engine/renderer/src/app/services/workflow-service";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation } from "./automation-provider";

export function WorkflowFeaturePage({ language }: { language: LanguageMode }): ReactElement {
  const { api, snapshot, setSnapshot, loading, error, refresh } = useAutomation();
  const snapshotRef = useRef(snapshot);
  const workflows = useMemo(() => workflowService(), []);
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
            onNewWorkflow={sidebar.onNewWorkflow}
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
          />
          <section className="automation-workflow-detail" onClick={(event) => event.stopPropagation()}>
            <WorkflowPage controller={manager.controller} />
          </section>
        </div>
      </AutomationPageState>
    </div>
  );
}
