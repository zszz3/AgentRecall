import { useCallback, useEffect, useRef } from "react";
import {
  Beaker,
  ClipboardCheck,
  Database,
  LayoutDashboard,
  Plus,
} from "lucide-react";
import type { AgentChannel, ConfiguredAgent, EvaluationDataset, EvaluationEvaluator, EvaluationExperiment } from "../../../../shared/types";
import type { Language } from "../../app/language";
import { APP_SAVE_REQUEST_EVENT } from "../../app/save-shortcut";
import {
  WorkbenchHeader,
  WorkbenchTabs,
  type WorkbenchTab,
} from "../../ui/workbench/Workbench";
import { DatasetWorkspace } from "./DatasetWorkspace";
import { EvaluationOverview } from "./EvaluationOverview";
import { EvaluatorWorkspace } from "./EvaluatorWorkspace";
import { ExperimentWorkspace } from "./ExperimentWorkspace";
import { EvaluatorTemplateMenu } from "./EvaluatorTemplateMenu";
import {
  type EvaluationApi,
  type EvaluationView,
  useEvaluationWorkbench,
} from "./useEvaluationWorkbench";

const VIEW_ICONS = {
  overview: LayoutDashboard,
  datasets: Database,
  evaluators: ClipboardCheck,
  experiments: Beaker,
};

export function EvaluationPage({
  language = "en",
  agents,
  channels,
  api,
  onNavigationGuardChange,
}: {
  language?: Language;
  agents: ConfiguredAgent[];
  channels: AgentChannel[];
  api: EvaluationApi;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const zh = language === "zh";
  const model = useEvaluationWorkbench(api);
  const draftRef = useRef<EvaluationDataset | EvaluationEvaluator | EvaluationExperiment | undefined>(undefined);
  const registerDraft = useCallback((value: EvaluationDataset | EvaluationEvaluator | EvaluationExperiment) => {
    draftRef.current = value;
    model.setDirty(true);
  }, [model.setDirty]);
  const tabs: WorkbenchTab<EvaluationView>[] = [
    { id: "overview", label: zh ? "概览" : "Overview" },
    {
      id: "datasets",
      label: zh ? "数据集" : "Datasets",
      count: model.datasets.length,
    },
    {
      id: "evaluators",
      label: zh ? "评估器" : "Evaluators",
      count: model.evaluators.length,
    },
    {
      id: "experiments",
      label: zh ? "实验" : "Experiments",
      count: model.experiments.length,
    },
  ];

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!model.dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [model.dirty]);

  useEffect(() => {
    if (!onNavigationGuardChange) return undefined;
    if (!model.dirty) {
      onNavigationGuardChange(null);
      return () => onNavigationGuardChange(null);
    }
    onNavigationGuardChange(async () => window.confirm(
      zh
        ? "当前评测修改尚未保存，确定离开吗？"
        : "Evaluation changes are not saved. Leave without saving?",
    ));
    return () => onNavigationGuardChange(null);
  }, [model.dirty, onNavigationGuardChange, zh]);

  useEffect(() => {
    const save = () => {
      const draft = draftRef.current;
      if (!model.dirty || !draft) return;
      if (model.view === "datasets") void model.saveDataset(draft as EvaluationDataset);
      if (model.view === "evaluators") void model.saveEvaluator(draft as EvaluationEvaluator);
      if (model.view === "experiments") void model.saveExperiment(draft as EvaluationExperiment);
    };
    window.addEventListener(APP_SAVE_REQUEST_EVENT, save);
    return () => window.removeEventListener(APP_SAVE_REQUEST_EVENT, save);
  }, [model.dirty, model.saveDataset, model.saveEvaluator, model.saveExperiment, model.view]);

  const navigate = useCallback(
    (view: EvaluationView, id?: string) => {
      if (
        model.dirty &&
        !window.confirm(
          zh
            ? "当前修改尚未保存，确定离开吗？"
            : "You have unsaved changes. Leave without saving?",
        )
      )
        return;
      model.setDirty(false);
      draftRef.current = undefined;
      model.select(view, id);
    },
    [model, zh],
  );

  const createForView = () => {
    if (model.view === "datasets") model.createDataset();
    else if (model.view === "evaluators") model.createEvaluator();
    else model.createExperiment(agents[0]?.id);
  };
  const title =
    model.view === "overview"
      ? zh
        ? "质量概览"
        : "Quality overview"
      : (tabs.find((tab) => tab.id === model.view)?.label ?? "Evaluation");
  const description =
    model.view === "overview"
      ? zh
        ? "查看 Agent 质量、失败 Case 和最近实验。"
        : "Review Agent quality, failing cases, and recent experiments."
      : model.view === "datasets"
        ? zh
          ? "维护可重复使用的输入与期望结果。"
          : "Maintain reusable inputs and expected outcomes."
        : model.view === "evaluators"
          ? zh
            ? "配置确定性规则和独立 LLM Judge。"
            : "Configure deterministic rules and independent LLM Judges."
          : zh
            ? "组合数据集、Agent 和评估器，运行质量检查。"
            : "Combine datasets, Agents, and evaluators into quality checks.";

  return (
    <section className="evaluation-workbench">
      <WorkbenchHeader
        eyebrow="EVALUATION"
        title={title}
        description={description}
        action={
          model.view === "overview" ? undefined : (
            <>
              <button
                className="control-btn compact is-active"
                type="button"
                onClick={createForView}
              >
                <Plus size={14} />
                {zh ? "新建" : "New"}
              </button>
              {model.view === "evaluators" ? (
                <EvaluatorTemplateMenu
                  zh={zh}
                  onSelect={model.createEvaluatorFromTemplate}
                />
              ) : null}
            </>
          )
        }
      />
      <WorkbenchTabs
        tabs={tabs}
        active={model.view}
        label={zh ? "评测视图" : "Evaluation views"}
        onChange={(view) => navigate(view)}
      />
      {model.error ? (
        <div className="workbench-error" role="alert">
          {model.error}
        </div>
      ) : null}
      <div className="evaluation-workbench-body">
        {model.view === "overview" ? (
          <EvaluationOverview
            zh={zh}
            datasets={model.datasets}
            evaluators={model.evaluators}
            experiments={model.experiments}
            runs={model.runs}
            agents={agents}
            onCreateExperiment={() => model.createExperiment(agents[0]?.id)}
          />
        ) : null}
        {model.view === "datasets" ? (
          <DatasetWorkspace
            zh={zh}
            datasets={model.datasets}
            selected={model.selectedDataset}
            busy={model.busy}
            onSelect={(id) => navigate("datasets", id)}
            onCreate={model.createDataset}
            onDraftChange={registerDraft}
            onSave={(value) => void model.saveDataset(value)}
            onDelete={() => {
              if (
                window.confirm(zh ? "删除这个数据集？" : "Delete this dataset?")
              )
                void model.deleteCurrent();
            }}
          />
        ) : null}
        {model.view === "evaluators" ? (
          <EvaluatorWorkspace
            zh={zh}
            evaluators={model.evaluators}
            selected={model.selectedEvaluator}
            channels={channels}
            busy={model.busy}
            onSelect={(id) => navigate("evaluators", id)}
            onCreate={model.createEvaluator}
            onDraftChange={registerDraft}
            onSave={(value) => void model.saveEvaluator(value)}
            onDelete={() => {
              if (
                window.confirm(
                  zh ? "删除这个评估器？" : "Delete this evaluator?",
                )
              )
                void model.deleteCurrent();
            }}
          />
        ) : null}
        {model.view === "experiments" ? (
          <ExperimentWorkspace
            zh={zh}
            experiments={model.experiments}
            selected={model.selectedExperiment}
            datasets={model.datasets}
            evaluators={model.evaluators}
            agents={agents}
            runs={model.experimentRuns}
            busy={model.busy}
            onSelect={(id) => navigate("experiments", id)}
            onCreate={() => model.createExperiment(agents[0]?.id)}
            onDraftChange={registerDraft}
            onSave={(value) => void model.saveExperiment(value)}
            onDelete={() => {
              if (
                window.confirm(
                  zh ? "删除这个实验？" : "Delete this experiment?",
                )
              )
                void model.deleteCurrent();
            }}
            onRun={(value) => void model.runExperiment(value)}
          />
        ) : null}
      </div>
    </section>
  );
}

export { VIEW_ICONS };
