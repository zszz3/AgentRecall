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
import { Badge, Button, Group, IconButton, Notice, PageBody, PageHeader, Row, Section, Switch } from "../../ui/primitives";
import { TeamResourceSection } from "../team-workspace/team-resource-section";
import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { TeamResourceCopy, TeamResourceShare } from "../team-workspace/team-configuration-panel";

type Pending = { id: LibraryAgentId; enabled: boolean; preview: LibraryPreview } | { id: LibraryAgentId; overwrite: true };

function readableError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

const STATE_TONE: Record<LibraryAgentState, "neutral" | "success" | "warning"> = {
  off: "neutral",
  synced: "success",
  conflict: "warning",
  unsupported: "neutral",
};

/** Personal instructions written into the user-level instructions file of every agent the user turns on. */
export function InstructionsPage({ language, onOpenTeamSpace }: { language: LanguageMode; onOpenTeamSpace?(): void }): ReactElement {
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
  // A team instruction only lands in the editor: the member reviews it and Save writes it to the agents.
  const copyTeamInstruction: TeamResourceCopy = {
    label: l("Add to my instructions", "加入个人指令"),
    run: async (change) => {
      if (change.kind !== "instructions") throw new Error(l("Only instructions can be added here.", "这里只能加入指令。"));
      const addition = change.value.content.trim();
      if (draft.includes(addition)) return l("Your instructions already include this.", "个人指令里已经有这段内容。");
      setDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${addition}` : addition);
      return l("Added to your instructions above. Save to write them to your agents.", "已加到上方的个人指令，点「保存」后才会写入 Agent。");
    },
  };

  // Sharing only opens the team editor with a new draft; the member reviews it, saves it to the team's local copy and pushes it.
  const paragraphs = draft.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
  const shareTeamInstruction: TeamResourceShare = {
    label: l("Share from my instructions", "从个人指令添加"),
    choices: [
      ...(paragraphs.length > 1 ? [{ key: "all", label: l("All my instructions", "全部个人指令"), hint: l(`${paragraphs.length} paragraphs`, `共 ${paragraphs.length} 段`), change: teamInstruction(l("My instructions", "个人指令"), paragraphs.join("\n\n")) }] : []),
      ...paragraphs.map((text, index) => ({ key: `paragraph-${index}`, label: paragraphTitle(text), change: teamInstruction(paragraphTitle(text), text) })),
      ...(paragraphs.length ? [] : [{ key: "empty", label: l("Your instructions are empty", "个人指令还是空的"), problem: l("Write them above first.", "先在上方写好再添加。") }]),
    ],
  };

  const stateLabel = (state: LibraryAgentState): string => ({
    off: l("Off", "未写入"),
    synced: l("Written", "已写入"),
    conflict: l("Changed outside AgentRecall", "文件里的内容被改过"),
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

  const agentNotes = (agent: LibraryAgentStatus): string[] => [
    ...(!agent.installed && agent.state !== "unsupported" ? [l("Not found on this machine.", "本机未发现这个 Agent。")] : []),
    ...(agent.override ? [l(
      `${agent.name} reads ${agent.override} instead while it exists, so these instructions have no effect there.`,
      `${agent.override} 存在时 ${agent.name} 只读它，这里的指令不会生效。`,
    )] : []),
    ...(agent.magpie ? [l("This file also has instructions magpie wrote; they may repeat these.", "这个文件里也有 magpie 写入的指令，内容可能重复。")] : []),
  ];

  return (
    <div className="instructions-page">
      <PageHeader
        title={l("Instructions", "指令")}
        description={l(
          "Personal instructions for every agent. AgentRecall writes them into the user-level instructions file of each agent you turn on and only changes its own block.",
          "希望所有 Agent 都遵守的个人指令。AgentRecall 把它们写进你开启的每个 Agent 的用户级指令文件，只改自己写入的那一段。",
        )}
        actions={<IconButton label={l("Refresh", "刷新")} icon={<RefreshCw size={15} />} disabled={busy !== null} onClick={() => void reload()} />}
      />
      <PageBody>
        {error ? <div role="alert" className="ui-notice ui-notice-error">{error}</div> : null}
        {snapshot && snapshot.retiredKept.length > 0 ? (
          <Notice kind="info">
            <p className="instructions-notice-text">{l(
              "AgentRecall no longer syncs MCP servers, slash commands or subagents and took back what it wrote. These files were changed after it wrote them, so they were kept:",
              "AgentRecall 不再同步 MCP、斜杠命令和子 Agent，已收回以前写入的内容。下面这些文件写入后被改过，已保留：",
            )}</p>
            <ul className="instructions-kept">{snapshot.retiredKept.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
            <Button size="sm" disabled={busy !== null} onClick={() => void run("dismiss", async () => apply(await window.sessionSearch.dismissPersonalLibraryRetiredKept()))}>
              {l("Got it", "知道了")}
            </Button>
          </Notice>
        ) : null}

        <Section
          title={l("Instructions", "指令")}
          actions={<Button size="sm" icon={<Download size={14} />} disabled={busy !== null || !snapshot} onClick={() => void openImport()}>{l("Import from agents", "从 Agent 导入")}</Button>}
        >
          <div className="instructions-editor">
            <textarea
              aria-label={l("Instructions", "指令")}
              value={draft}
              disabled={!snapshot}
              placeholder={l("For example: Answer in Chinese. Run the tests before saying a change is done.", "例如：用中文回答。说改完之前先跑测试。")}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="ui-form-actions">
              <span className="instructions-hint">{l(
                "Saving updates every agent that is turned on, except files whose block was changed outside AgentRecall.",
                "保存后会更新所有已开启的 Agent；文件里的区块被改过的除外。",
              )}</span>
              <Button variant="primary" disabled={!dirty || busy !== null} onClick={() => void run("save", async () => apply(await window.sessionSearch.savePersonalLibraryInstructions(draft)))}>
                {busy === "save" ? l("Saving…", "正在保存…") : l("Save", "保存")}
              </Button>
            </div>
          </div>

          {candidates ? (
            <div className="instructions-import">
              {candidates.length === 0 ? (
                <p className="instructions-hint">{l("The agents' instructions files have nothing that is not already here.", "各 Agent 的指令文件里没有这里之外的内容。")}</p>
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
                          <span className="instructions-paragraph">{candidate.text}</span>
                        </label>
                        <span className="instructions-hint">{candidate.agents.map((id) => names.get(id) ?? id).join(" / ")}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="instructions-check">
                    <input type="checkbox" checked={removeFromSources} onChange={() => setRemoveFromSources((value) => !value)} />
                    <span>{l("Also remove them from the original files (each file is backed up first)", "同时从原文件中移出（每个文件会先备份）")}</span>
                  </label>
                </>
              )}
              {dirty ? <p className="instructions-hint">{l("Save or undo your edits before importing.", "导入前请先保存或撤销你的修改。")}</p> : null}
              <div className="ui-form-actions">
                <Button disabled={busy !== null} onClick={() => setCandidates(null)}>{l("Cancel", "取消")}</Button>
                {candidates.length > 0 ? (
                  <Button variant="primary" disabled={busy !== null || chosen.size === 0 || dirty} onClick={() => void importChosen()}>
                    {l(`Add ${chosen.size} paragraph${chosen.size === 1 ? "" : "s"}`, `加入 ${chosen.size} 段`)}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Section>

        <Section title={l("Agents", "Agent")} description={l("Turn on the agents that should read these instructions. You see the file before anything is written.", "开启后，Agent 会读到这些指令。写入前会先显示文件内容。")}>
          <Group>
            {snapshot?.agents.map((agent) => (
              <div key={agent.id} className="instructions-agent" data-agent={agent.id} data-state={agent.state}>
                <Row
                  title={agent.name}
                  description={<>
                    {agent.file ? <code className="instructions-file">{agent.file}</code> : null}
                    {agentNotes(agent).map((note) => <span key={note} className="instructions-note">{note}</span>)}
                  </>}
                  trailing={<>
                    {agent.state === "off" ? null : <Badge tone={STATE_TONE[agent.state]}>{stateLabel(agent.state)}</Badge>}
                    <Switch
                      label={agent.name}
                      checked={agent.enabled}
                      disabled={busy !== null || pending !== null || agent.state === "unsupported" || agent.state === "conflict"}
                      onChange={() => void toggle(agent)}
                    />
                  </>}
                />
                {agent.state === "conflict" ? (
                  <div className="instructions-agent-actions">
                    <span className="instructions-hint">{l("Choose which version to keep:", "选择保留哪个版本：")}</span>
                    <Button size="sm" disabled={busy !== null}
                      onClick={() => void run(agent.id, async () => apply(await window.sessionSearch.resolvePersonalLibraryConflict(agent.id, "use-file")))}>
                      {l("Use the file's version", "用文件里的版本")}
                    </Button>
                    <Button size="sm" disabled={busy !== null} onClick={() => setPending({ id: agent.id, overwrite: true })}>
                      {l("Overwrite the file", "覆盖文件")}
                    </Button>
                  </div>
                ) : null}
                {pending?.id === agent.id ? (
                  <div className="instructions-confirm">
                    {"overwrite" in pending ? (
                      <p>{l(
                        "The block in this file will be replaced with these instructions. The file is backed up first.",
                        "这个文件里的区块会被替换成这里的指令，替换前会先备份。",
                      )}</p>
                    ) : pending.preview.before === pending.preview.after ? (
                      <p>{l("The file does not change.", "文件内容不会变化。")}</p>
                    ) : (
                      <>
                        <p>{pending.enabled ? l("The file will look like this:", "写入后文件内容：") : l("AgentRecall's block will be removed, leaving:", "将移除 AgentRecall 写入的区块，之后文件内容：")}</p>
                        <pre>{pending.preview.after || l("(empty)", "（空）")}</pre>
                      </>
                    )}
                    <div className="ui-form-actions">
                      <Button size="sm" disabled={busy !== null} onClick={() => setPending(null)}>{l("Cancel", "取消")}</Button>
                      <Button size="sm" variant="primary" disabled={busy !== null} onClick={confirm}>{l("Confirm", "确认")}</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </Group>
        </Section>
        <Section title={l("Team instructions", "团队指令")} description={l("Your team's shared instructions, written into project files of connected working directories when the team pulls them.", "团队共享的指令，Pull 后写进已接入工作目录的项目指令文件。")}>
          <TeamResourceSection kind="instructions" language={language} onOpenTeamSpace={onOpenTeamSpace} copy={copyTeamInstruction} share={shareTeamInstruction} />
        </Section>
      </PageBody>
    </div>
  );
}

/** The first line of a paragraph without Markdown markers, short enough for a menu and a team instruction name. */
function paragraphTitle(text: string): string {
  const line = text.split("\n")[0]!.replace(/^[#>*\-+\s]+/, "").trim() || text.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

function teamInstruction(name: string, content: string): ConfigurationChange {
  // A content hash keeps the suggested identifier stable while the member edits other paragraphs.
  let hash = 2166136261;
  for (const char of content) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return { kind: "instructions", operation: "create", value: { id: `instructions-${hash.toString(16)}`, name, content, targets: ["codex", "claude"] } };
}
