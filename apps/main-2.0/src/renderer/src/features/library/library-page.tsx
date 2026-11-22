import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Download, RefreshCw } from "lucide-react";

import type { LibraryAgentId } from "../../../../core/library-agent-ids";
import type {
  LibraryAgentState,
  LibraryAgentStatus,
  LibraryImportCandidate,
  LibraryPreview,
  PersonalLibrarySnapshot,
} from "../../../../shared/ipc/personal-library";
import { localize, type LanguageMode } from "../../language";

type Pending = { id: LibraryAgentId; enabled: boolean; preview: LibraryPreview } | { id: LibraryAgentId; overwrite: true };

function readableError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

/** The personal Library: one set of instructions written into the user-level files of the agents the user turns on. */
export function LibraryPage({ language }: { language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [snapshot, setSnapshot] = useState<PersonalLibrarySnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [candidates, setCandidates] = useState<LibraryImportCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [removeFromSources, setRemoveFromSources] = useState(false);

  const apply = (next: PersonalLibrarySnapshot) => {
    setSnapshot(next);
    setDraft(next.instructions);
  };

  const run = useCallback(async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const reload = useCallback(() => run("load", async () => apply(await window.sessionSearch.getPersonalLibrary())), [run]);
  useEffect(() => { void reload(); }, [reload]);

  const names = new Map(snapshot?.agents.map((agent) => [agent.id, agent.name]) ?? []);
  const dirty = snapshot !== null && draft.trim() !== snapshot.instructions;

  const stateLabel = (state: LibraryAgentState): string => ({
    off: l("Off", "未写入"),
    synced: l("Written", "已写入"),
    conflict: l("Changed outside AgentRecall", "文件里的内容被改过"),
    magpie: l("Managed by magpie", "由 magpie 管理"),
    unsupported: l("No user-level instructions file", "没有用户级指令文件"),
  })[state];

  const toggle = (agent: LibraryAgentStatus) => run(agent.id, async () => {
    const enabled = !agent.enabled;
    setPending({ id: agent.id, enabled, preview: await window.sessionSearch.previewPersonalLibraryAgent(agent.id, enabled) });
  });

  const confirm = () => {
    if (!pending) return;
    void run(pending.id, async () => {
      apply("overwrite" in pending
        ? await window.sessionSearch.resolvePersonalLibraryConflict(pending.id, "overwrite")
        : await window.sessionSearch.setPersonalLibraryAgentEnabled(pending.id, pending.enabled));
      setPending(null);
    });
  };

  const openImport = () => run("import", async () => {
    const found = await window.sessionSearch.listPersonalLibraryImports();
    setCandidates(found);
    setChosen(new Set(found.map((candidate) => candidate.text)));
    setRemoveFromSources(false);
  });

  const importChosen = () => run("import", async () => {
    apply(await window.sessionSearch.importPersonalLibraryParagraphs([...chosen], removeFromSources));
    setCandidates(null);
  });

  return (
    <div className="library-page">
      <header className="app-page-head">
        <div>
          <h2>Library</h2>
          <p>{l(
            "Instructions you want every agent to follow. AgentRecall writes them into the user-level instructions file of each agent you turn on and never changes the rest of those files.",
            "希望所有 Agent 都遵守的指令。AgentRecall 会把它们写进你开启的每个 Agent 的用户级指令文件，不会改动这些文件里的其他内容。",
          )}</p>
        </div>
        <button type="button" className="settings-action-button" disabled={busy !== null} onClick={() => void reload()}>
          <RefreshCw size={14} /> {l("Refresh", "刷新")}
        </button>
      </header>

      {error ? <p className="library-error" role="alert">{error}</p> : null}

      <section className="library-surface" aria-label={l("Instructions", "指令")}>
        <div className="library-row">
          <h3>{l("Instructions", "指令")}</h3>
          <button type="button" className="settings-action-button" disabled={busy !== null || !snapshot} onClick={() => void openImport()}>
            <Download size={14} /> {l("Import from agents", "从 Agent 导入")}
          </button>
        </div>
        <textarea
          className="library-instructions"
          value={draft}
          disabled={!snapshot}
          placeholder={l("For example: Answer in Chinese. Run the tests before saying a change is done.", "例如：用中文回答。说改完之前先跑测试。")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="library-row">
          <p className="library-hint">{l(
            "Saving updates every agent that is turned on, except files whose block was changed outside AgentRecall.",
            "保存后会更新所有已开启的 Agent；文件里的区块被改过的除外。",
          )}</p>
          <button
            type="button"
            className="primary-action"
            disabled={!dirty || busy !== null}
            onClick={() => void run("save", async () => apply(await window.sessionSearch.savePersonalLibraryInstructions(draft)))}
          >
            {busy === "save" ? l("Saving…", "正在保存…") : l("Save", "保存")}
          </button>
        </div>

        {candidates ? (
          <div className="library-import">
            {candidates.length === 0 ? (
              <p className="library-hint">{l("The agents' instructions files have nothing that is not already in the Library.", "各 Agent 的指令文件里没有 Library 之外的内容。")}</p>
            ) : (
              <>
                <ul>
                  {candidates.map((candidate) => (
                    <li key={candidate.text}>
                      <label>
                        <input
                          type="checkbox"
                          checked={chosen.has(candidate.text)}
                          onChange={() => setChosen((current) => {
                            const next = new Set(current);
                            if (!next.delete(candidate.text)) next.add(candidate.text);
                            return next;
                          })}
                        />
                        <span className="library-paragraph">{candidate.text}</span>
                      </label>
                      <span className="library-hint">{candidate.agents.map((id) => names.get(id) ?? id).join(" / ")}</span>
                    </li>
                  ))}
                </ul>
                <label className="library-check">
                  <input type="checkbox" checked={removeFromSources} onChange={() => setRemoveFromSources((value) => !value)} />
                  <span>{l("Also remove them from the original files (each file is backed up first)", "同时从原文件中移出（每个文件会先备份）")}</span>
                </label>
              </>
            )}
            <div className="library-row library-actions">
              <button type="button" className="settings-action-button" disabled={busy !== null} onClick={() => setCandidates(null)}>{l("Cancel", "取消")}</button>
              {candidates.length > 0 ? (
                <button type="button" className="primary-action" disabled={busy !== null || chosen.size === 0 || dirty} onClick={() => void importChosen()}>
                  {l(`Add ${chosen.size} to the Library`, `加入 Library（${chosen.size} 段）`)}
                </button>
              ) : null}
            </div>
            {dirty ? <p className="library-hint">{l("Save or undo your edits before importing.", "导入前请先保存或撤销你的修改。")}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="library-surface" aria-label={l("Agents", "Agent")}>
        <h3>{l("Agents", "Agent")}</h3>
        <ul className="library-agents">
          {snapshot?.agents.map((agent) => (
            <li key={agent.id} data-agent={agent.id} data-state={agent.state}>
              <div className="library-agent-main">
                <label className="library-check">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={agent.name}
                    checked={agent.enabled}
                    disabled={busy !== null || pending !== null || agent.state === "unsupported" || agent.state === "conflict" || (agent.state === "magpie" && !agent.enabled)}
                    onChange={() => void toggle(agent)}
                  />
                  <strong>{agent.name}</strong>
                </label>
                <span className={`library-state ${agent.state}`}>{stateLabel(agent.state)}</span>
              </div>
              {agent.file ? <code className="library-file">{agent.file}</code> : null}
              {!agent.installed && agent.state !== "unsupported" ? <span className="library-hint">{l("Not found on this machine.", "本机未发现这个 Agent。")}</span> : null}
              {agent.override ? (
                <span className="library-hint">{l(
                  `${agent.name} reads ${agent.override} instead while it exists, so the Library has no effect there.`,
                  `${agent.override} 存在时 ${agent.name} 只读它，Library 的内容不会生效。`,
                )}</span>
              ) : null}
              {agent.state === "conflict" ? (
                <div className="library-row library-actions">
                  <span className="library-hint">{l("Choose which version to keep:", "选择保留哪个版本：")}</span>
                  <button type="button" className="settings-action-button" disabled={busy !== null}
                    onClick={() => void run(agent.id, async () => apply(await window.sessionSearch.resolvePersonalLibraryConflict(agent.id, "use-file")))}>
                    {l("Use the file's version", "用文件里的版本")}
                  </button>
                  <button type="button" className="settings-action-button" disabled={busy !== null} onClick={() => setPending({ id: agent.id, overwrite: true })}>
                    {l("Overwrite the file", "覆盖文件")}
                  </button>
                </div>
              ) : null}
              {pending?.id === agent.id ? (
                <div className="library-confirm">
                  {"overwrite" in pending ? (
                    <p>{l(
                      "The block in this file will be replaced with the Library's instructions. The file is backed up first.",
                      "这个文件里的区块会被替换成 Library 的指令，替换前会先备份。",
                    )}</p>
                  ) : pending.preview.before === pending.preview.after ? (
                    <p>{l("The file does not change.", "文件内容不会变化。")}</p>
                  ) : (
                    <>
                      <p>{pending.enabled ? l("The file will look like this:", "写入后文件内容：") : l("The Library block will be removed:", "将移除 Library 区块，之后文件内容：")}</p>
                      <pre>{pending.preview.after || l("(empty)", "（空）")}</pre>
                    </>
                  )}
                  <div className="library-row library-actions">
                    <button type="button" className="settings-action-button" disabled={busy !== null} onClick={() => setPending(null)}>{l("Cancel", "取消")}</button>
                    <button type="button" className="primary-action" disabled={busy !== null} onClick={confirm}>{l("Confirm", "确认")}</button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
