import { useCallback, useEffect, useState } from "react";
import type {
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  EvaluationRunSummary,
  ListEvaluationRunsRequest,
} from "../../../../shared/types";
import type { EvaluationEvaluatorTemplate } from "../../../../shared/evaluation-templates";
import { createBlankEvaluator, createEvaluatorFromTemplate } from "./evaluator-factory";

export interface EvaluationApi {
  listEvaluationDatasets: () => Promise<EvaluationDataset[]>;
  saveEvaluationDataset: (value: EvaluationDataset) => Promise<EvaluationDataset>;
  deleteEvaluationDataset: (id: string) => Promise<boolean>;
  listEvaluationEvaluators: () => Promise<EvaluationEvaluator[]>;
  saveEvaluationEvaluator: (value: EvaluationEvaluator) => Promise<EvaluationEvaluator>;
  deleteEvaluationEvaluator: (id: string) => Promise<boolean>;
  listEvaluationExperiments: () => Promise<EvaluationExperiment[]>;
  saveEvaluationExperiment: (value: EvaluationExperiment) => Promise<EvaluationExperiment>;
  deleteEvaluationExperiment: (id: string) => Promise<boolean>;
  listEvaluationRuns: (request?: ListEvaluationRunsRequest) => Promise<EvaluationRunPage>;
  getEvaluationRun: (runId: string) => Promise<EvaluationRun | undefined>;
  runEvaluationExperiment: (experimentId: string) => Promise<EvaluationRun>;
}

export type EvaluationView =
  | "overview"
  | "datasets"
  | "evaluators"
  | "experiments";

export function useEvaluationWorkbench(api: EvaluationApi) {
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[]>([]);
  const [experiments, setExperiments] = useState<EvaluationExperiment[]>([]);
  const [runs, setRuns] = useState<EvaluationRunSummary[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [overviewRunDetails, setOverviewRunDetails] = useState<EvaluationRun[]>([]);
  const [experimentRuns, setExperimentRuns] = useState<EvaluationRunSummary[]>([]);
  const [experimentRunTotal, setExperimentRunTotal] = useState(0);
  const [latestExperimentRun, setLatestExperimentRun] = useState<EvaluationRun>();
  const [runReloadVersion, setRunReloadVersion] = useState(0);
  const [view, setView] = useState<EvaluationView>("overview");
  const [selectedIds, setSelectedIds] = useState<
    Partial<Record<EvaluationView, string>>
  >({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<
    "save" | "delete" | "run" | "load" | undefined
  >("load");
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    setBusy("load");
    setError(undefined);
    try {
      const [nextDatasets, nextEvaluators, nextExperiments, nextRunPage] =
        await Promise.all([
          api.listEvaluationDatasets(),
          api.listEvaluationEvaluators(),
          api.listEvaluationExperiments(),
          api.listEvaluationRuns({ limit: 50 }),
        ]);
      const nextRunDetails = (await Promise.all(
        nextRunPage.items.slice(0, 6).map((run) => api.getEvaluationRun(run.id)),
      )).filter((run): run is EvaluationRun => Boolean(run));
      setDatasets(nextDatasets);
      setEvaluators(nextEvaluators);
      setExperiments(nextExperiments);
      setRuns(nextRunPage.items);
      setRunTotal(nextRunPage.total);
      setOverviewRunDetails(nextRunDetails);
      setRunReloadVersion((version) => version + 1);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "load" ? undefined : current));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectedDataset =
    datasets.find((item) => item.id === selectedIds.datasets) ?? datasets[0];
  const selectedEvaluator =
    evaluators.find((item) => item.id === selectedIds.evaluators) ??
    evaluators[0];
  const selectedExperiment =
    experiments.find((item) => item.id === selectedIds.experiments) ??
    experiments[0];

  useEffect(() => {
    let active = true;
    if (!selectedExperiment) {
      setExperimentRuns([]);
      setExperimentRunTotal(0);
      setLatestExperimentRun(undefined);
      return () => { active = false; };
    }
    void api.listEvaluationRuns({ experimentId: selectedExperiment.id, limit: 50 }).then(async (page) => {
      const latest = page.items[0] ? await api.getEvaluationRun(page.items[0].id) : undefined;
      if (!active) return;
      setExperimentRuns(page.items);
      setExperimentRunTotal(page.total);
      setLatestExperimentRun(latest);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [api, runReloadVersion, selectedExperiment?.id]);

  const select = useCallback((targetView: EvaluationView, id?: string) => {
    setView(targetView);
    if (id) setSelectedIds((current) => ({ ...current, [targetView]: id }));
  }, []);

  const createDataset = useCallback(() => {
    const now = Date.now();
    const value: EvaluationDataset = {
      id: `dataset-${now}`,
      name: "新数据集",
      description: "",
      items: [{ id: `item-${now}`, input: "", metadata: {}, sequence: 0 }],
      createdAt: now,
      updatedAt: now,
    };
    setDatasets((items) => [value, ...items]);
    setSelectedIds((ids) => ({ ...ids, datasets: value.id }));
    setView("datasets");
    setDirty(true);
  }, []);
  const addEvaluator = useCallback((value: EvaluationEvaluator) => {
    setEvaluators((items) => [value, ...items]);
    setSelectedIds((ids) => ({ ...ids, evaluators: value.id }));
    setView("evaluators");
    setDirty(true);
  }, []);
  const createEvaluator = useCallback(() => addEvaluator(createBlankEvaluator()), [addEvaluator]);
  const createEvaluatorFromTemplateDefinition = useCallback(
    (template: EvaluationEvaluatorTemplate) => addEvaluator(createEvaluatorFromTemplate(template)),
    [addEvaluator],
  );
  const createExperiment = useCallback(
    (agentId = "") => {
      const now = Date.now();
      const value: EvaluationExperiment = {
        id: `experiment-${now}`,
        name: "新实验",
        datasetId: datasets[0]?.id ?? "",
        agentId,
        evaluatorIds: evaluators
          .filter((item) => item.enabled)
          .map((item) => item.id),
        repetitions: 1,
        createdAt: now,
        updatedAt: now,
      };
      setExperiments((items) => [value, ...items]);
      setSelectedIds((ids) => ({ ...ids, experiments: value.id }));
      setView("experiments");
      setDirty(true);
    },
    [datasets, evaluators],
  );

  const saveDataset = useCallback(async (value: EvaluationDataset) => {
    setBusy("save");
    setError(undefined);
    try {
      await api.saveEvaluationDataset({ ...value, updatedAt: Date.now() });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "save" ? undefined : current));
    }
  }, [api, reload]);

  const saveEvaluator = useCallback(async (value: EvaluationEvaluator) => {
    setBusy("save");
    setError(undefined);
    try {
      await api.saveEvaluationEvaluator({ ...value, updatedAt: Date.now() });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "save" ? undefined : current));
    }
  }, [api, reload]);

  const saveExperiment = useCallback(async (value: EvaluationExperiment) => {
    setBusy("save");
    setError(undefined);
    try {
      await api.saveEvaluationExperiment({ ...value, updatedAt: Date.now() });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "save" ? undefined : current));
    }
  }, [api, reload]);

  const deleteCurrent = useCallback(async () => {
    setBusy("delete");
    setError(undefined);
    try {
      if (view === "datasets" && selectedDataset)
        await api.deleteEvaluationDataset(selectedDataset.id);
      if (view === "evaluators" && selectedEvaluator)
        await api.deleteEvaluationEvaluator(
          selectedEvaluator.id,
        );
      if (view === "experiments" && selectedExperiment)
        await api.deleteEvaluationExperiment(
          selectedExperiment.id,
        );
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "delete" ? undefined : current));
    }
  }, [api, reload, selectedDataset, selectedEvaluator, selectedExperiment, view]);

  const runExperiment = useCallback(async (value: EvaluationExperiment) => {
    setBusy("run");
    setError(undefined);
    try {
      await api.saveEvaluationExperiment({
        ...value,
        updatedAt: Date.now(),
      });
      await api.runEvaluationExperiment(
        value.id,
      );
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => (current === "run" ? undefined : current));
    }
  }, [api, reload]);
  const loadMoreExperimentRuns = useCallback(async () => {
    if (!selectedExperiment || experimentRuns.length >= experimentRunTotal) return;
    setBusy("load");
    setError(undefined);
    try {
      const page = await api.listEvaluationRuns({
        experimentId: selectedExperiment.id,
        offset: experimentRuns.length,
        limit: 50,
      });
      setExperimentRuns((current) => [...current, ...page.items]);
      setExperimentRunTotal(page.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((current) => current === "load" ? undefined : current);
    }
  }, [api, experimentRunTotal, experimentRuns.length, selectedExperiment]);
  return {
    datasets,
    evaluators,
    experiments,
    runs,
    runTotal,
    overviewRunDetails,
    view,
    selectedDataset,
    selectedEvaluator,
    selectedExperiment,
    experimentRuns,
    experimentRunTotal,
    latestExperimentRun,
    dirty,
    busy,
    error,
    select,
    setDirty,
    createDataset,
    createEvaluator,
    createEvaluatorFromTemplate: createEvaluatorFromTemplateDefinition,
    createExperiment,
    saveDataset,
    saveEvaluator,
    saveExperiment,
    deleteCurrent,
    runExperiment,
    loadMoreExperimentRuns,
  };
}
