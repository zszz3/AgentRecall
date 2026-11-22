import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, CheckCircle2, Pencil, Play, Plus, Trash2, X } from "lucide-react";

import type { SkillEvalSuite } from "../../../../main/services/skill-service";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { CreateSuiteDialog } from "./eval-suite-dialog";
import { SuiteRunsSection } from "./eval-suite-runs";

// Skill regression evaluation (phase four). Cases are the specification the user
// defines ("given this input, expect this output"); runs executed through the
// automation engine are the evidence. Suites are fetched for the selected skill,
// and each run is attributed to the then-current skill hash.
export function EvalSuitesCard({
  language,
  skill,
  onOpenSession,
}: {
  language: LanguageMode;
  skill: string;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [suites, setSuites] = useState<SkillEvalSuite[] | null>(null);
  const [activeRun, setActiveRun] = useState<{
    suiteId: string;
    runId: string;
    done: number;
    total: number;
    status: string;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = closed; editing null = creating a new suite.
  const [dialog, setDialog] = useState<{ editing: SkillEvalSuite | null } | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setSuites(await window.sessionSearch.listSkillEvalSuites(skill));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [skill]);

  useEffect(() => {
    setSuites(null);
    void reload();
  }, [reload]);

  const run = useCallback(async (suite: SkillEvalSuite) => {
    setError(null);
    try {
      const { runId } = await window.sessionSearch.runSkillEvalSuite(suite.id);
      setActiveRun({
        suiteId: suite.id,
        runId,
        done: 0,
        total: suite.caseCount * suite.repetitions,
        status: "running",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // The run executes in the main process; poll its persisted snapshot for
  // progress and stop once it reaches a terminal status.
  const activeRunId = activeRun?.runId ?? null;
  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const run = await window.sessionSearch.getSkillEvalRun(activeRunId);
          if (cancelled || !run) return;
          setActiveRun((current) => current && current.runId === run.id
            ? { ...current, done: run.results.length, status: run.status }
            : current);
          if (run.status !== "running") {
            clearInterval(timer);
            await reload();
          }
        } catch {
          // Polling is best-effort; the next tick retries.
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRunId, reload]);

  const cancelRun = useCallback(async () => {
    if (!activeRun) return;
    try {
      await window.sessionSearch.cancelSkillEvalRun(activeRun.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [activeRun]);

  const remove = useCallback(async (suite: SkillEvalSuite) => {
    const confirmed = window.confirm(l(
      `Delete suite "${suite.name}" and its run history?`,
      `删除方案「${suite.name}」及其运行历史？`,
    ));
    if (!confirmed) return;
    setDeletingId(suite.id);
    setError(null);
    try {
      await window.sessionSearch.deleteSkillEvalSuite(suite.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingId(null);
    }
  }, [l, reload]);

  return (
    <div className="eval-card eval-suites-card">
      <header>
        <h4>{l("Regression evaluation", "回归评测")}</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {suites !== null && suites.length > 0 ? (
            <span className="eval-evidence-tag">{l(`${suites.length} suite(s)`, `${suites.length} 个方案`)}</span>
          ) : null}
          <button type="button" className="eval-create-button" onClick={() => setDialog({ editing: null })}>
            <Plus size={13} />{l("New suite", "新建方案")}
          </button>
        </div>
      </header>

      {error ? <p className="eval-error" role="alert">{error}</p> : null}

      {suites === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : suites.length === 0 ? (
        <p className="eval-muted">{l(
          "No regression suite yet. Define cases once re-run this skill after it changes.",
          "还没有回归评测方案。定义测试用例，就能在该 Skill 改动后重跑验证。",
        )}</p>
      ) : (
        <ul className="eval-suite-list">
          {suites.map((suite) => (
            <li key={suite.id} className="eval-suite-item">
              <div className="eval-suite-row-main">
                <span className="eval-suite-item-name">{suite.name}</span>
                <span className="eval-muted">{l(`${suite.caseCount} cases`, `${suite.caseCount} 个用例`)}</span>
                {suite.drifted ? (
                  <span className="eval-badge eval-badge-warn" title={l(
                    "The skill version changed since the last run.",
                    "该 Skill 自上次运行后版本已变化。",
                  )}>
                    <AlertTriangle size={11} />{l("Version drifted", "版本已变化")}
                  </span>
                ) : suite.skillHash ? (
                  <span className="eval-badge eval-badge-dim">
                    <CheckCircle2 size={11} />{l("Current version", "当前版本")}
                  </span>
                ) : null}
              </div>
              <div className="eval-suite-row-sub">
                <span className="eval-muted">
                  {suite.lastRun
                    ? `${l("Last run", "上次运行")} ${formatRelativeTime(suite.lastRun.startedAt, language)} · ${l("pass", "通过")} ${suite.lastRun.passRate != null ? Math.round(suite.lastRun.passRate * 100) : "—"}%`
                    : l("Never run", "从未运行")}
                  {" · "}×{suite.repetitions}
                </span>
                {activeRun && activeRun.suiteId === suite.id && activeRun.status === "running" ? (
                  <>
                    <span className="eval-evidence-tag">
                      {l(`Running ${activeRun.done}/${activeRun.total}`, `运行中 ${activeRun.done}/${activeRun.total}`)}
                    </span>
                    <button
                      type="button"
                      className="eval-run-button eval-suite-delete"
                      onClick={() => void cancelRun()}
                    >
                      <X size={12} />{l("Cancel", "取消")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="eval-run-button"
                    disabled={Boolean(activeRun && activeRun.status === "running")}
                    onClick={() => void run(suite)}
                  >
                    <Play size={12} />{l("Run", "运行")}
                  </button>
                )}
                <button
                  type="button"
                  className="eval-run-button"
                  aria-label={l(`Edit suite ${suite.name}`, `编辑方案 ${suite.name}`)}
                  onClick={() => setDialog({ editing: suite })}
                >
                  <Pencil size={12} />{l("Edit", "编辑")}
                </button>
                <button
                  type="button"
                  className="eval-run-button eval-suite-delete"
                  aria-label={l(`Delete suite ${suite.name}`, `删除方案 ${suite.name}`)}
                  disabled={deletingId === suite.id}
                  onClick={() => void remove(suite)}
                >
                  <Trash2 size={12} />{deletingId === suite.id ? l("Deleting...", "删除中...") : l("Delete", "删除")}
                </button>
              </div>
              <SuiteRunsSection language={language} suite={suite} onOpenSession={onOpenSession} />
            </li>
          ))}
        </ul>
      )}

      {dialog ? (
        <CreateSuiteDialog
          language={language}
          skill={skill}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
