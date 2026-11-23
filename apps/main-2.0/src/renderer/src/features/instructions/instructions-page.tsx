import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ExternalLink, FolderOpen, RefreshCw } from "lucide-react";

import type { InstructionFile } from "../../../../shared/ipc/instructions";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import { ResizableSplit } from "../../components/resizable-split";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage, CatalogSearch } from "../../ui/catalog";
import { Badge, Button, EmptyState, IconButton } from "../../ui/primitives";
import { useTeamCatalogs } from "../team-workspace/use-team-catalogs";

interface TeamInstruction { key: string; team: string; name: string; content: string; files: string[] }
type Selection = { kind: "file"; file: InstructionFile } | { kind: "team"; item: TeamInstruction };

const MAX_PREVIEW_CHARS = 60_000;

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function readable(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

/**
 * Every instruction file agents read on this machine — user-level files, files at the root of
 * projects with Sessions, and team instructions — shown read-only. Agents and people edit the
 * files themselves; the page opens them in the editor.
 */
export function InstructionsPage({ language, onOpenTeamSpace, teamApi = window.sessionSearch.teamWorkspace }: {
  language: LanguageMode;
  onOpenTeamSpace?(): void;
  teamApi?: TeamWorkspaceApi;
}): ReactElement {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const api = window.sessionSearch;
  const [refreshKey, setRefreshKey] = useState(0);
  const [files, setFiles] = useState<InstructionFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [content, setContent] = useState<{ key: string; text: string } | { key: string; error: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const team = useTeamCatalogs(teamApi, refreshKey);

  useEffect(() => {
    let active = true;
    setError(null);
    api.listInstructionFiles().then(
      (next) => { if (active) setFiles(next); },
      (cause: unknown) => { if (active) { setFiles([]); setError(readable(cause)); } },
    );
    return () => { active = false; };
  }, [api, refreshKey]);

  const teamItems = useMemo<TeamInstruction[]>(() => (team.teams ?? []).flatMap(({ team: owner, catalog }) =>
    (catalog.assets?.configuration?.instructions ?? []).map((item) => ({
      key: `team:${owner.id}:${item.id}`,
      team: owner.name,
      name: item.name,
      content: item.content,
      files: item.targets.map((target) => target === "codex" ? "AGENTS.md" : "CLAUDE.md"),
    }))), [team.teams]);

  const needle = query.trim().toLowerCase();
  const matches = (...texts: Array<string | null>) => !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  const shownFiles = (files ?? []).filter((file) => matches(file.name, file.path, file.project, ...file.agents, ...file.aliases));
  const userFiles = shownFiles.filter((file) => file.scope === "user");
  const projects = [...new Set(shownFiles.flatMap((file) => file.project ? [file.project] : []))];
  const shownTeam = teamItems.filter((item) => matches(item.name, item.team, item.content));
  const teams = [...new Set(shownTeam.map((item) => item.team))];

  const selections: Array<{ key: string; selection: Selection }> = [
    ...userFiles.map((file) => ({ key: `file:${file.path}`, selection: { kind: "file" as const, file } })),
    ...projects.flatMap((project) => shownFiles.filter((file) => file.project === project).map((file) => ({ key: `file:${file.path}`, selection: { kind: "file" as const, file } }))),
    ...shownTeam.map((item) => ({ key: item.key, selection: { kind: "team" as const, item } })),
  ];
  const current = selections.find((entry) => entry.key === selectedKey) ?? selections[0] ?? null;
  const currentFile = current?.selection.kind === "file" ? current.selection.file : null;

  useEffect(() => {
    if (!currentFile) return;
    let active = true;
    const key = `file:${currentFile.path}`;
    setContent((previous) => previous?.key === key ? previous : null);
    api.readInstructionFile(currentFile.path).then(
      (text) => { if (active) setContent({ key, text }); },
      (cause: unknown) => { if (active) setContent({ key, error: readable(cause) }); },
    );
    return () => { active = false; };
  }, [api, currentFile?.path, currentFile?.modifiedAt, refreshKey]);

  async function run(action: () => Promise<void>) {
    setActionError(null);
    try { await action(); }
    catch (cause) { setActionError(readable(cause)); }
  }

  const fileCount = files?.length ?? 0;
  const projectCount = new Set((files ?? []).flatMap((file) => file.project ? [file.project] : [])).size;
  const meta = files === null ? l("Looking for instruction files…", "正在查找指令文件…")
    : l(`${fileCount} files · ${projectCount} projects${teamItems.length ? ` · ${teamItems.length} team instructions` : ""}`,
      `${fileCount} 个文件 · ${projectCount} 个项目${teamItems.length ? ` · ${teamItems.length} 条团队指令` : ""}`);

  const item = (key: string, title: string, metaText: string, trailing?: ReactElement) =>
    <CatalogItem key={key} title={title} meta={metaText} trailing={trailing} selected={current?.key === key} onSelect={() => { setSelectedKey(key); setActionError(null); }} />;
  const emptyBadge = (file: InstructionFile) => file.size === 0 ? <Badge>{l("Empty", "空")}</Badge> : undefined;

  const list = <div className="catalog-list" aria-label={l("Instruction files", "指令文件")}>
    {userFiles.length > 0 ? <CatalogGroup title={l("Agents", "Agent 用户级")} hint={l("Read in every project", "在所有项目中生效")} count={userFiles.length}>
      {userFiles.map((file) => item(`file:${file.path}`, file.agents.join(" · "), file.name, emptyBadge(file)))}
    </CatalogGroup> : null}
    {projects.map((project) => {
      const inProject = shownFiles.filter((file) => file.project === project);
      return <CatalogGroup key={project} title={folderName(project)} hint={project} count={inProject.length}>
        {inProject.map((file) => item(`file:${file.path}`, file.name,
          file.aliases.length ? l(`Also ${file.aliases.map((alias) => alias.slice(project.length + 1)).join(", ")}`, `也是 ${file.aliases.map((alias) => alias.slice(project.length + 1)).join("、")}`) : sizeLabel(file.size),
          emptyBadge(file)))}
      </CatalogGroup>;
    })}
    {teams.map((name) => {
      const inTeam = shownTeam.filter((entry) => entry.team === name);
      return <CatalogGroup key={`team:${name}`} title={l(`Team · ${name}`, `团队 · ${name}`)} count={inTeam.length}>
        {inTeam.map((entry) => item(entry.key, entry.name, entry.files.join(" · ")))}
      </CatalogGroup>;
    })}
    {files !== null && selections.length === 0 ? <p className="catalog-list-empty">{needle ? l("Nothing matches.", "没有匹配的指令。") : l("No instruction files found.", "没有找到指令文件。")}</p> : null}
  </div>;

  let detail: ReactElement;
  if (!current) {
    detail = <EmptyState
      title={files === null ? l("Looking for instruction files…", "正在查找指令文件…") : l("No instruction files", "没有指令文件")}
      description={l("AgentRecall looks at each agent's user-level instructions and at AGENTS.md, CLAUDE.md and similar files in projects with Sessions.", "AgentRecall 会查看各 Agent 的用户级指令，以及有会话的项目根目录里的 AGENTS.md、CLAUDE.md 等文件。")}
    />;
  } else if (current.selection.kind === "file") {
    const file = current.selection.file;
    const shown = content?.key === current.key ? content : null;
    detail = <CatalogDetail
      title={file.name}
      subtitle={<code>{file.path}</code>}
      facts={[
        file.scope === "user"
          ? { label: l("Read by", "读取它的 Agent"), value: file.agents.join("、") }
          : { label: l("Project", "项目"), value: file.project ?? "" },
        ...(file.aliases.length ? [{ label: l("Also reached as", "其他路径"), value: file.aliases.join("、") }] : []),
        { label: l("Size", "大小"), value: sizeLabel(file.size) },
        { label: l("Modified", "修改时间"), value: new Date(file.modifiedAt).toLocaleString() },
      ]}
      actions={<>
        <Button size="sm" variant="primary" icon={<ExternalLink size={14} />} onClick={() => void run(() => api.openInstructionFile(file.path))}>{l("Open in editor", "用编辑器打开")}</Button>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void run(() => api.revealInstructionFile(file.path))}>{l("Show in folder", "在文件夹中显示")}</Button>
      </>}
    >
      {actionError ? <p role="alert" className="ui-notice ui-notice-error">{actionError}</p> : null}
      {shown === null ? <p className="catalog-detail-status">{l("Reading…", "正在读取…")}</p>
        : "error" in shown ? <p role="alert" className="ui-notice ui-notice-error">{shown.error}</p>
          : shown.text.trim() ? <div className="catalog-markdown"><Markdown text={markdownPreview(shown.text, MAX_PREVIEW_CHARS, l("…(truncated; open the file to see the rest)", "…（已截断，打开文件查看完整内容）"))} language={language} /></div>
            : <p className="catalog-detail-status">{l("This file is empty.", "这个文件是空的。")}</p>}
    </CatalogDetail>;
  } else {
    const entry = current.selection.item;
    detail = <CatalogDetail
      title={entry.name}
      subtitle={l(`Team ${entry.team}`, `团队 ${entry.team}`)}
      facts={[{ label: l("Written into", "写入"), value: entry.files.join("、") }]}
      actions={onOpenTeamSpace ? <Button size="sm" onClick={onOpenTeamSpace}>{l("Edit in team space", "去团队空间编辑")}</Button> : undefined}
    >
      <p className="catalog-detail-status">{l("Pull writes team instructions into the instruction files of connected working folders.", "Pull 后，团队指令会写进已接入工作目录的项目指令文件。")}</p>
      <div className="catalog-markdown"><Markdown text={markdownPreview(entry.content, MAX_PREVIEW_CHARS, l("…(truncated)", "…（已截断）"))} language={language} /></div>
    </CatalogDetail>;
  }

  return <CatalogPage
    title={l("Instructions", "指令")}
    meta={meta}
    search={<CatalogSearch value={query} onChange={setQuery} label={l("Search instructions", "搜索指令")} placeholder={l("Search files, agents or projects", "搜索文件、Agent 或项目")} />}
    actions={<IconButton label={l("Look again", "重新查找")} icon={<RefreshCw size={15} />} onClick={() => setRefreshKey((value) => value + 1)} />}
  >
    {error ? <p role="alert" className="ui-notice ui-notice-error catalog-error">{error}</p> : null}
    {team.problems.map((problem) => <p key={problem.team} role="alert" className="ui-notice ui-notice-error catalog-error">{problem.team ? `${problem.team}: ` : ""}{problem.message}</p>)}
    <ResizableSplit className="catalog-split" label={l("Resize the list", "调整列表宽度")} storageKey="agent-recall-instructions-pane" initialWidth={300} minWidth={220} maxWidth={460}>
      {list}
      <div className="catalog-detail-pane">{detail}</div>
    </ResizableSplit>
  </CatalogPage>;
}
