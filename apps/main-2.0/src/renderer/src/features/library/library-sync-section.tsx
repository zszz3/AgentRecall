import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Download } from "lucide-react";

import type { LibraryAgentId } from "../../../../core/library-agent-ids";
import type { LibrarySyncAgentState, LibrarySyncAgentStatus, LibrarySyncPreview, PersonalLibrarySnapshot } from "../../../../shared/ipc/personal-library";
import { localize, type LanguageMode } from "../../language";

export interface LibrarySyncCandidate<T> {
  name: string;
  value: T;
  agents: LibraryAgentId[];
}

/** What one Library kind (MCP servers, slash commands, subagents) needs from the main process. */
export interface LibrarySyncAdapter<T> {
  save(items: Record<string, T>): Promise<PersonalLibrarySnapshot>;
  preview(id: LibraryAgentId, enabled: boolean): Promise<LibrarySyncPreview>;
  setEnabled(id: LibraryAgentId, enabled: boolean): Promise<PersonalLibrarySnapshot>;
  overwrite(id: LibraryAgentId): Promise<PersonalLibrarySnapshot>;
  listImports(): Promise<Array<LibrarySyncCandidate<T>>>;
  importItems(items: Array<{ name: string; value: T }>): Promise<PersonalLibrarySnapshot>;
}

type Pending = { id: LibraryAgentId; enabled: boolean; preview: LibrarySyncPreview } | { id: LibraryAgentId; overwrite: true };

const format = (items: Record<string, unknown>) => JSON.stringify(items, null, 2);

/**
 * One Library kind edited as JSON by name, with the agents it is written to.
 * The same rules apply to every kind: only items AgentRecall wrote are changed,
 * and anything else with a Library name is left until the user overwrites it.
 */
export function LibrarySyncSection<T>({ language, kind, title, hint, items, agents, describe, adapter, busy, run, apply }: {
  language: LanguageMode;
  kind: string;
  title: string;
  hint: string;
  items: Record<string, T> | null;
  agents: LibrarySyncAgentStatus[];
  describe: (value: T) => string;
  adapter: LibrarySyncAdapter<T>;
  busy: boolean;
  run: (label: string, operation: () => Promise<void>) => Promise<void>;
  apply: (snapshot: PersonalLibrarySnapshot) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [draft, setDraft] = useState("{}");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [candidates, setCandidates] = useState<Array<LibrarySyncCandidate<T>> | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  const saved = items ? format(items) : "{}";
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved;

  const stateLabel = (state: LibrarySyncAgentState): string => ({
    off: l("Off", "未写入"),
    synced: l("Written", "已写入"),
    conflict: l("Some items were not written", "有内容未写入"),
    error: l("Cannot read the file", "文件读不出来"),
    unsupported: l("Not supported by this agent", "这个 Agent 不支持"),
  })[state];

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(l("Write an object keyed by name.", "请写成以名称为键的对象。"));
    } catch (cause) {
      setInvalid(l(`This is not valid JSON: ${(cause as Error).message}`, `不是有效的 JSON：${(cause as Error).message}`));
      return;
    }
    setInvalid(null);
    void run(`${kind}-save`, async () => apply(await adapter.save(parsed as Record<string, T>)));
  };

  const toggle = (id: LibraryAgentId, enabled: boolean) => run(`${kind}-${id}`, async () => {
    setPending({ id, enabled, preview: await adapter.preview(id, enabled) });
  });

  const confirm = () => {
    if (!pending) return;
    void run(`${kind}-${pending.id}`, async () => {
      apply("overwrite" in pending ? await adapter.overwrite(pending.id) : await adapter.setEnabled(pending.id, pending.enabled));
      setPending(null);
    });
  };

  const openImport = () => run(`${kind}-import`, async () => {
    const found = await adapter.listImports();
    setCandidates(found);
    setChosen(new Set(found.map((_, index) => index)));
  });

  const importChosen = () => run(`${kind}-import`, async () => {
    apply(await adapter.importItems((candidates ?? []).filter((_, index) => chosen.has(index)).map(({ name, value }) => ({ name, value }))));
    setCandidates(null);
  });

  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const list = (label: string, values: string[]) => values.length > 0 ? <p>{label}{values.join(", ")}</p> : null;

  return (
    <section className={`library-surface library-sync library-${kind}`} aria-label={title}>
      <div className="library-row">
        <h3>{title}</h3>
        <button type="button" className="settings-action-button" disabled={busy || !items} onClick={() => void openImport()}>
          <Download size={14} /> {l("Import from agents", "从 Agent 导入")}
        </button>
      </div>
      <p className="library-hint">{hint}</p>
      <textarea className="library-instructions" spellCheck={false} value={draft} disabled={!items} onChange={(event) => setDraft(event.target.value)} />
      {invalid ? <p className="library-error-inline" role="alert">{invalid}</p> : null}
      <div className="library-row">
        <p className="library-hint">{l(
          "Saving updates every agent that is turned on. Items changed outside AgentRecall, or with a name the agent already uses, are left as they are.",
          "保存后会更新所有已开启的 Agent；在外部改过的、或与 Agent 已有内容同名的，保持原样。",
        )}</p>
        <button type="button" className="primary-action" disabled={!dirty || busy} onClick={save}>{l("Save", "保存")}</button>
      </div>

      {candidates ? (
        <div className="library-import">
          {candidates.length === 0 ? (
            <p className="library-hint">{l("The agents have nothing that is not already in the Library.", "各 Agent 中没有 Library 之外的内容。")}</p>
          ) : (
            <ul>
              {candidates.map((candidate, index) => (
                <li key={`${candidate.name}-${index}`}>
                  <label>
                    <input type="checkbox" checked={chosen.has(index)} onChange={() => setChosen((current) => {
                      const next = new Set(current);
                      if (!next.delete(index)) next.add(index);
                      return next;
                    })} />
                    <span className="library-paragraph"><strong>{candidate.name}</strong> {describe(candidate.value)}</span>
                  </label>
                  <span className="library-hint">{candidate.agents.map((id) => names.get(id) ?? id).join(" / ")}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="library-row library-actions">
            <button type="button" className="settings-action-button" disabled={busy} onClick={() => setCandidates(null)}>{l("Cancel", "取消")}</button>
            {candidates.length > 0 ? (
              <button type="button" className="primary-action" disabled={busy || chosen.size === 0 || dirty} onClick={() => void importChosen()}>
                {l(`Add ${chosen.size} to the Library`, `加入 Library（${chosen.size} 项）`)}
              </button>
            ) : null}
          </div>
          {dirty ? <p className="library-hint">{l("Save or undo your edits before importing.", "导入前请先保存或撤销你的修改。")}</p> : null}
        </div>
      ) : null}

      <ul className="library-agents">
        {agents.map((agent) => (
          <li key={agent.id} data-sync-agent={agent.id} data-state={agent.state}>
            <div className="library-agent-main">
              <label className="library-check">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={agent.name}
                  checked={agent.enabled}
                  disabled={busy || pending !== null || agent.state === "unsupported"}
                  onChange={() => void toggle(agent.id, !agent.enabled)}
                />
                <strong>{agent.name}</strong>
              </label>
              <span className={`library-state ${agent.state === "error" ? "conflict" : agent.state}`}>{stateLabel(agent.state)}</span>
            </div>
            {agent.file ? <code className="library-file">{agent.file}</code> : null}
            {agent.problem ? <span className="library-hint">{agent.problem}</span> : null}
            {agent.state === "conflict" ? (
              <div className="library-row library-actions">
                <span className="library-hint">{l(`Not written: ${agent.conflicts.join(", ")}`, `未写入：${agent.conflicts.join("、")}`)}</span>
                <button type="button" className="settings-action-button" disabled={busy} onClick={() => setPending({ id: agent.id, overwrite: true })}>
                  {l("Overwrite", "覆盖")}
                </button>
              </div>
            ) : null}
            {pending?.id === agent.id ? (
              <div className="library-confirm">
                {"overwrite" in pending ? (
                  <p>{l(
                    "Every Library item will replace the agent's one with the same name. What it replaces is backed up first.",
                    "Library 中的每一项都会替换 Agent 中的同名项，被替换的内容会先备份。",
                  )}</p>
                ) : (
                  <>
                    {list(l("Adds: ", "新增："), pending.preview.add)}
                    {list(l("Replaces: ", "替换："), pending.preview.update)}
                    {list(l("Removes: ", "移除："), pending.preview.remove)}
                    {list(pending.enabled ? l("Leaves as they are (name already used): ", "保持原样（已有同名项）：") : l("Leaves in place (changed outside AgentRecall): ", "保留（在外部改过）："), pending.preview.conflicts)}
                    {pending.preview.add.length + pending.preview.update.length + pending.preview.remove.length === 0 ? <p>{l("Nothing changes.", "不会有变化。")}</p> : null}
                  </>
                )}
                <div className="library-row library-actions">
                  <button type="button" className="settings-action-button" disabled={busy} onClick={() => setPending(null)}>{l("Cancel", "取消")}</button>
                  <button type="button" className="primary-action" disabled={busy} onClick={confirm}>{l("Confirm", "确认")}</button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
