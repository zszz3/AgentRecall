import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Download } from "lucide-react";

import type { LibraryAgentId } from "../../../../core/library-agent-ids";
import type { LibraryMcpServers } from "../../../../core/library-mcp-server";
import type {
  LibraryMcpAgentState,
  LibraryMcpImportCandidate,
  LibraryMcpPreview,
  PersonalLibrarySnapshot,
} from "../../../../shared/ipc/personal-library";
import { localize, type LanguageMode } from "../../language";

type Pending = { id: LibraryAgentId; enabled: boolean; preview: LibraryMcpPreview } | { id: LibraryAgentId; overwrite: true };

const format = (servers: LibraryMcpServers) => JSON.stringify(servers, null, 2);

/** The Library's MCP servers and the agents they are written to. */
export function LibraryMcpSection({ language, mcp, busy, run, apply }: {
  language: LanguageMode;
  mcp: PersonalLibrarySnapshot["mcp"] | null;
  busy: boolean;
  run: (label: string, operation: () => Promise<void>) => Promise<void>;
  apply: (snapshot: PersonalLibrarySnapshot) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [draft, setDraft] = useState("{}");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [candidates, setCandidates] = useState<LibraryMcpImportCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  const saved = mcp ? format(mcp.servers) : "{}";
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft.trim() !== saved;

  const stateLabel = (state: LibraryMcpAgentState): string => ({
    off: l("Off", "未写入"),
    synced: l("Written", "已写入"),
    conflict: l("Some servers were not written", "有服务器未写入"),
    error: l("Cannot read the file", "文件读不出来"),
    unsupported: l("No user-level MCP file AgentRecall can write", "没有可写入的用户级 MCP 文件"),
  })[state];

  const save = () => {
    let servers: LibraryMcpServers;
    try {
      const parsed: unknown = JSON.parse(draft || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(l("Write an object of servers by name.", "请写成以服务器名为键的对象。"));
      servers = parsed as LibraryMcpServers;
    } catch (cause) {
      setInvalid(l(`The servers are not valid JSON: ${(cause as Error).message}`, `服务器配置不是有效的 JSON：${(cause as Error).message}`));
      return;
    }
    setInvalid(null);
    void run("mcp-save", async () => apply(await window.sessionSearch.savePersonalLibraryMcpServers(servers)));
  };

  const toggle = (id: LibraryAgentId, enabled: boolean) => run(`mcp-${id}`, async () => {
    setPending({ id, enabled, preview: await window.sessionSearch.previewPersonalLibraryMcp(id, enabled) });
  });

  const confirm = () => {
    if (!pending) return;
    void run(`mcp-${pending.id}`, async () => {
      apply("overwrite" in pending
        ? await window.sessionSearch.overwritePersonalLibraryMcp(pending.id)
        : await window.sessionSearch.setPersonalLibraryMcpAgentEnabled(pending.id, pending.enabled));
      setPending(null);
    });
  };

  const openImport = () => run("mcp-import", async () => {
    const found = await window.sessionSearch.listPersonalLibraryMcpImports();
    setCandidates(found);
    setChosen(new Set(found.map((_, index) => index)));
  });

  const importChosen = () => run("mcp-import", async () => {
    const list = (candidates ?? []).filter((_, index) => chosen.has(index)).map(({ name, server }) => ({ name, server }));
    apply(await window.sessionSearch.importPersonalLibraryMcpServers(list));
    setCandidates(null);
  });

  const names = new Map(mcp?.agents.map((agent) => [agent.id, agent.name]) ?? []);
  const list = (label: string, items: string[]) => items.length > 0 ? <p>{label}{items.join(", ")}</p> : null;

  return (
    <section className="library-surface library-mcp" aria-label={l("MCP servers", "MCP 服务器")}>
      <div className="library-row">
        <h3>{l("MCP servers", "MCP 服务器")}</h3>
        <button type="button" className="settings-action-button" disabled={busy || !mcp} onClick={() => void openImport()}>
          <Download size={14} /> {l("Import from agents", "从 Agent 导入")}
        </button>
      </div>
      <p className="library-hint">{l(
        'One entry per server: {"name": {"command": "npx", "args": ["-y", "pkg"], "env": {}}} for a local command or {"name": {"url": "https://…", "headers": {}}} for a remote one. AgentRecall writes each in the agent\'s own format.',
        '每个服务器一项：本地命令写 {"名称": {"command": "npx", "args": ["-y", "pkg"], "env": {}}}，远程服务写 {"名称": {"url": "https://…", "headers": {}}}。AgentRecall 会按各 Agent 自己的格式写入。',
      )}</p>
      <textarea className="library-instructions" spellCheck={false} value={draft} disabled={!mcp} onChange={(event) => setDraft(event.target.value)} />
      {invalid ? <p className="library-error-inline" role="alert">{invalid}</p> : null}
      <div className="library-row">
        <p className="library-hint">{l(
          "Saving updates every agent that is turned on. Servers changed outside AgentRecall, or with a name the agent already uses, are left as they are.",
          "保存后会更新所有已开启的 Agent；在外部改过的服务器、或与 Agent 已有服务器同名的，保持原样。",
        )}</p>
        <button type="button" className="primary-action" disabled={!dirty || busy} onClick={save}>{l("Save servers", "保存服务器")}</button>
      </div>

      {candidates ? (
        <div className="library-import">
          {candidates.length === 0 ? (
            <p className="library-hint">{l("The agents have no MCP servers that are not already in the Library.", "各 Agent 中没有 Library 之外的 MCP 服务器。")}</p>
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
                    <span className="library-paragraph"><strong>{candidate.name}</strong> {"command" in candidate.server ? [candidate.server.command, ...(candidate.server.args ?? [])].join(" ") : candidate.server.url}</span>
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
                {l(`Add ${chosen.size} to the Library`, `加入 Library（${chosen.size} 个）`)}
              </button>
            ) : null}
          </div>
          {dirty ? <p className="library-hint">{l("Save or undo your edits before importing.", "导入前请先保存或撤销你的修改。")}</p> : null}
        </div>
      ) : null}

      <ul className="library-agents">
        {mcp?.agents.map((agent) => (
          <li key={agent.id} data-mcp-agent={agent.id} data-state={agent.state}>
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
                  {l("Overwrite the file", "覆盖文件")}
                </button>
              </div>
            ) : null}
            {pending?.id === agent.id ? (
              <div className="library-confirm">
                {"overwrite" in pending ? (
                  <p>{l(
                    "Every Library server will replace the agent's entry with the same name. The file is backed up first.",
                    "Library 中的每个服务器都会替换 Agent 中的同名项，替换前会先备份文件。",
                  )}</p>
                ) : (
                  <>
                    {list(l("Adds: ", "新增："), pending.preview.add)}
                    {list(l("Replaces: ", "替换："), pending.preview.update)}
                    {list(l("Removes: ", "移除："), pending.preview.remove)}
                    {list(pending.enabled ? l("Leaves as they are (same name already used): ", "保持原样（已有同名项）：") : l("Leaves in the file (changed outside AgentRecall): ", "留在文件中（在外部改过）："), pending.preview.conflicts)}
                    {pending.preview.add.length + pending.preview.update.length + pending.preview.remove.length === 0 ? <p>{l("The file does not change.", "文件内容不会变化。")}</p> : null}
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
