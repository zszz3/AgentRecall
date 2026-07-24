import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  BookOpen,
  FolderOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

import type {
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
  OpenVikingWorkspace,
} from "../../../../core/openviking-memory";
import type { OpenVikingDirectoryPreview } from "../../../../main/services/openviking-memory-service";
import { localize, type LanguageMode } from "../../language";

type PageAction =
  | "choose"
  | "add"
  | "refresh"
  | "search"
  | "read"
  | "save"
  | "delete-memory"
  | "import"
  | "stop"
  | "delete-workspace"
  | null;

export function OpenVikingMemoryPage({
  language,
  enabled,
  onOpenSettings,
}: {
  language: LanguageMode;
  enabled: boolean;
  onOpenSettings: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [snapshot, setSnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenVikingDirectoryPreview | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVikingMemoryItem[]>([]);
  const [selected, setSelected] = useState<OpenVikingMemoryItem | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [action, setAction] = useState<PageAction>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.sessionSearch.getOpenVikingMemorySnapshot();
    setSnapshot(next);
    setWorkspaceId((current) => {
      if (current && next.workspaces.some((workspace) => workspace.id === current)) return current;
      return next.workspaces.find((workspace) => workspace.managed)?.id
        ?? next.workspaces[0]?.id
        ?? null;
    });
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [enabled, refresh]);

  const transient = Boolean(
    action === "import"
    || snapshot?.runtime.state === "installing"
    || snapshot?.runtime.state === "starting"
    || snapshot?.workspaces.some((workspace) =>
      ["idle", "queued", "running"].includes(workspace.importState)),
  );

  useEffect(() => {
    if (!enabled || !transient) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, transient]);

  const workspace = useMemo(
    () => snapshot?.workspaces.find((item) => item.id === workspaceId) ?? null,
    [snapshot, workspaceId],
  );
  const ready = snapshot?.runtime.state !== "not-installed" && snapshot?.model.installed;
  const manualMemoryId = selected ? manualIdFromUri(selected.id) : null;
  const canEditSelected = Boolean(selected && (!selected.id || manualMemoryId));

  const run = async (nextAction: Exclude<PageAction, null>, operation: () => Promise<void>) => {
    setAction(nextAction);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const chooseDirectory = () => run("choose", async () => {
    setPreview(await window.sessionSearch.chooseOpenVikingDirectory());
  });

  const addWorkspace = () => {
    if (!preview) return;
    void run("add", async () => {
      const added = await window.sessionSearch.addOpenVikingWorkspace(preview.rootPath);
      setPreview(null);
      setWorkspaceId(added.id);
      await refresh();
    });
  };

  const startImport = (target: OpenVikingWorkspace, resume: boolean) => {
    setAction("import");
    setError(null);
    const request = resume
      ? window.sessionSearch.resumeOpenVikingImport(target.id)
      : window.sessionSearch.pauseOpenVikingImport(target.id);
    void request
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => {
        setAction(null);
        void refresh().catch((cause) => setError(errorMessage(cause)));
      });
    void refresh().catch((cause) => setError(errorMessage(cause)));
  };

  const search = () => {
    if (!workspace || !query.trim()) return;
    void run("search", async () => {
      const next = await window.sessionSearch.searchOpenVikingMemories(workspace.id, query.trim(), 30);
      setResults(next);
      setSelected(null);
    });
  };

  const openMemory = (memory: OpenVikingMemoryItem) => run("read", async () => {
    const content = memory.content || await window.sessionSearch.readOpenVikingMemory(
      memory.workspaceId,
      memory.id,
    );
    const next = { ...memory, content };
    setSelected(next);
    setDraftTitle(next.title);
    setDraftContent(content);
  });

  const newMemory = () => {
    if (!workspace) return;
    setSelected({
      id: "",
      workspaceId: workspace.id,
      title: "",
      content: "",
    });
    setDraftTitle("");
    setDraftContent("");
  };

  const saveMemory = () => {
    if (!workspace || !selected || !canEditSelected || !draftTitle.trim()) return;
    void run("save", async () => {
      const saved = await window.sessionSearch.saveOpenVikingMemory(workspace.id, {
        ...(manualMemoryId ? { id: manualMemoryId } : {}),
        title: draftTitle.trim(),
        content: draftContent,
      });
      setSelected(saved);
      setDraftTitle(saved.title);
      setDraftContent(saved.content);
      if (query.trim()) setResults(
        await window.sessionSearch.searchOpenVikingMemories(workspace.id, query.trim(), 30),
      );
    });
  };

  const deleteMemory = () => {
    if (!workspace || !selected?.id) return;
    if (!window.confirm(l("Delete this memory permanently?", "永久删除这条记忆？"))) return;
    void run("delete-memory", async () => {
      await window.sessionSearch.deleteOpenVikingMemory(workspace.id, selected.id);
      setResults((current) => current.filter((item) => item.id !== selected.id));
      setSelected(null);
    });
  };

  const stopManaging = () => {
    if (!workspace) return;
    if (!window.confirm(l(
      "Stop managing this directory? Its OpenViking data will be kept.",
      "停止管理这个目录？OpenViking 中的数据会保留。",
    ))) return;
    void run("stop", async () => {
      await window.sessionSearch.stopManagingOpenVikingWorkspace(workspace.id);
      await refresh();
    });
  };

  const deleteWorkspace = () => {
    if (!workspace) return;
    if (!window.confirm(l(
      "Delete this directory's OpenViking memory permanently? This cannot be undone.",
      "永久删除这个目录的 OpenViking 记忆？此操作无法撤销。",
    ))) return;
    void run("delete-workspace", async () => {
      await window.sessionSearch.deleteOpenVikingWorkspace(workspace.id);
      setResults([]);
      setSelected(null);
      await refresh();
    });
  };

  if (!enabled) {
    return (
      <div className="openviking-memory-page">
        <header className="app-page-head">
          <div>
            <h2>{l("Memory", "记忆")}</h2>
            <p>{l("Directory-scoped long-term memory for your coding agents.", "面向编码 Agent 的目录级长期记忆。")}</p>
          </div>
        </header>
        <section className="openviking-disabled-state">
          <span><BookOpen size={24} /></span>
          <h3>{l("Directory memory is off by default", "目录记忆默认关闭")}</h3>
          <p>{l(
            "Enable it explicitly, download the managed component and model, then choose only the directories you want AgentRecall to manage.",
            "请先手动开启并下载托管组件与模型，然后只选择你希望 AgentRecall 管理的目录。",
          )}</p>
          <button type="button" onClick={onOpenSettings}><Settings2 size={15} />{l("Open Settings", "前往设置")}</button>
        </section>
      </div>
    );
  }

  return (
    <div className="openviking-memory-page">
      <header className="app-page-head openviking-page-head">
        <div>
          <h2>{l("Memory", "记忆")}</h2>
          <p>{l("Each managed directory has isolated sessions, memories and indexes.", "每个受管理目录都有隔离的会话、记忆和索引。")}</p>
        </div>
        <div className="openviking-page-actions">
          <button type="button" onClick={() => void refresh()} disabled={action !== null}>
            <RefreshCw size={14} className={action === "refresh" ? "spin" : ""} />{l("Refresh", "刷新")}
          </button>
          <button type="button" className="primary" onClick={() => void chooseDirectory()} disabled={action !== null || !ready}>
            <FolderOpen size={14} />{l("Manage directory", "管理目录")}
          </button>
        </div>
      </header>

      {!ready && snapshot ? (
        <section className="openviking-setup-notice">
          <div>
            <strong>{l("Finish Memory setup", "完成记忆设置")}</strong>
            <span>{l(
              "Download both OpenViking and the local embedding model before adding a directory.",
              "添加目录前，请先下载 OpenViking 与本地向量模型。",
            )}</span>
          </div>
          <button type="button" onClick={onOpenSettings}><Settings2 size={14} />{l("Open Settings", "前往设置")}</button>
        </section>
      ) : null}

      {error ? <div className="openviking-feedback error"><span>{error}</span><button onClick={() => setError(null)}><X size={13} /></button></div> : null}

      {!snapshot ? (
        <div className="openviking-loading"><RefreshCw size={18} className="spin" />{l("Loading memory…", "正在加载记忆…")}</div>
      ) : snapshot.workspaces.length === 0 ? (
        <section className="openviking-empty-state">
          <span><FolderOpen size={23} /></span>
          <h3>{l("No managed directories", "还没有受管理目录")}</h3>
          <p>{l(
            "Choose directories one by one. AgentRecall never combines memory across them.",
            "逐个选择目录；AgentRecall 不会把不同目录的记忆串联起来。",
          )}</p>
          <button type="button" onClick={() => void chooseDirectory()} disabled={!ready || action !== null}>
            <Plus size={14} />{l("Add directory", "添加目录")}
          </button>
        </section>
      ) : (
        <div className="openviking-memory-layout">
          <aside className="openviking-workspaces">
            <header>
              <strong>{l("Directories", "目录")}</strong>
              <button type="button" onClick={() => void chooseDirectory()} disabled={!ready || action !== null} aria-label={l("Add directory", "添加目录")}>
                <Plus size={14} />
              </button>
            </header>
            <div>
              {snapshot.workspaces.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === workspaceId ? "active" : ""}
                  onClick={() => {
                    setWorkspaceId(item.id);
                    setResults([]);
                    setSelected(null);
                  }}
                >
                  <FolderOpen size={15} />
                  <span>
                    <strong>{item.displayName}</strong>
                    <small title={item.rootPath}>{item.rootPath}</small>
                  </span>
                  <em className={item.managed ? item.importState : "stopped"}>
                    {item.managed ? importLabel(item, language) : l("Stopped", "已停止")}
                  </em>
                </button>
              ))}
            </div>
          </aside>

          <section className="openviking-memory-browser">
            {workspace ? (
              <>
                <header className="openviking-workspace-head">
                  <div>
                    <strong>{workspace.displayName}</strong>
                    <span title={workspace.rootPath}>{workspace.rootPath}</span>
                  </div>
                  <div>
                    {workspace.importState === "running" ? (
                      <button type="button" onClick={() => startImport(workspace, false)} disabled={action !== null}>
                        <Pause size={13} />{l("Pause import", "暂停导入")}
                      </button>
                    ) : ["paused", "failed", "idle"].includes(workspace.importState) && workspace.managed ? (
                      <button type="button" onClick={() => startImport(workspace, true)} disabled={action !== null}>
                        <Play size={13} />{l("Resume import", "继续导入")}
                      </button>
                    ) : null}
                    {workspace.managed ? (
                      <button type="button" onClick={stopManaging} disabled={action !== null}>
                        <CircleStopIcon />{l("Stop managing", "停止管理")}
                      </button>
                    ) : null}
                    <button type="button" className="danger" onClick={deleteWorkspace} disabled={action !== null}>
                      <Trash2 size={13} />{l("Delete data", "删除数据")}
                    </button>
                  </div>
                </header>

                <div className="openviking-import-status">
                  <span>{importLabel(workspace, language)}</span>
                  <div><i
                    className={workspace.importState === "running" ? "active" : ""}
                    style={{ width: importProgress(workspace) }}
                  /></div>
                  <em>{l(
                    `Imported ${workspace.importedTurns} / ${workspace.totalTurns} · ${importProgress(workspace)}`,
                    `已导入 ${workspace.importedTurns} / ${workspace.totalTurns} · ${importProgress(workspace)}`,
                  )}</em>
                </div>

                <form className="openviking-search" onSubmit={(event) => { event.preventDefault(); search(); }}>
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={l("Search this directory's memory", "搜索当前目录的记忆")}
                  />
                  <button type="submit" disabled={!query.trim() || action !== null}>{l("Search", "搜索")}</button>
                  <button type="button" onClick={newMemory} disabled={!workspace.managed || action !== null}>
                    <Plus size={13} />{l("New", "新建")}
                  </button>
                </form>

                <div className="openviking-memory-content">
                  <div className="openviking-result-list">
                    {results.length === 0 ? (
                      <div className="openviking-result-empty">{l(
                        "Search memory or create a manual note.",
                        "搜索记忆，或新建一条手动记忆。",
                      )}</div>
                    ) : results.map((memory) => (
                      <button
                        type="button"
                        key={memory.id}
                        className={selected?.id === memory.id ? "active" : ""}
                        onClick={() => void openMemory(memory)}
                      >
                        <strong>{memory.title}</strong>
                        <span>{memory.content || memory.source || memory.id}</span>
                        {memory.score !== undefined ? <em>{memory.score.toFixed(2)}</em> : null}
                      </button>
                    ))}
                  </div>

                  <div className="openviking-memory-detail">
                    {selected ? (
                      <>
                        <header>
                          <strong>{selected.id ? l("Memory detail", "记忆详情") : l("New memory", "新建记忆")}</strong>
                          <button type="button" onClick={() => setSelected(null)}><X size={14} /></button>
                        </header>
                        <input
                          value={draftTitle}
                          readOnly={!canEditSelected}
                          onChange={(event) => setDraftTitle(event.currentTarget.value)}
                          placeholder={l("Title", "标题")}
                        />
                        <textarea
                          value={draftContent}
                          readOnly={!canEditSelected}
                          onChange={(event) => setDraftContent(event.currentTarget.value)}
                          placeholder={l("What should agents remember?", "希望 Agent 记住什么？")}
                        />
                        <footer>
                          <span>{canEditSelected ? l("Manual memory", "手动记忆") : l("Generated memory · read only", "自动生成的记忆 · 只读")}</span>
                          <div>
                            {selected.id ? (
                              <button type="button" className="danger" onClick={deleteMemory} disabled={action !== null}>
                                <Trash2 size={13} />{l("Delete", "删除")}
                              </button>
                            ) : null}
                            {canEditSelected ? (
                              <button type="button" className="primary" onClick={saveMemory} disabled={!draftTitle.trim() || action !== null}>
                                <Save size={13} />{l("Save", "保存")}
                              </button>
                            ) : null}
                          </div>
                        </footer>
                      </>
                    ) : (
                      <div className="openviking-detail-empty"><BookOpen size={21} />{l("Select a memory", "选择一条记忆")}</div>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}

      {preview ? (
        <div className="openviking-preview-backdrop" onMouseDown={() => setPreview(null)}>
          <section className="openviking-preview-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h3>{preview.relinkWorkspaceId ? l("Relink moved project", "重新关联已移动项目") : l("Manage this directory?", "管理这个目录？")}</h3>
                <p>{preview.rootPath}</p>
              </div>
              <button type="button" onClick={() => setPreview(null)}><X size={15} /></button>
            </header>
            <div className="openviking-preview-facts">
              <span><strong>{preview.sessionCount}</strong>{l(" existing sessions will be imported", " 个已有会话将被导入")}</span>
              <span>{l("Memory remains isolated from every other directory.", "记忆将与其他所有目录保持隔离。")}</span>
              {preview.existingWorkspaceId ? <span>{l("This directory already has a retained workspace.", "这个目录已有保留的 workspace，将恢复管理。")}</span> : null}
            </div>
            <footer>
              <button type="button" onClick={() => setPreview(null)}>{l("Cancel", "取消")}</button>
              <button type="button" className="primary" onClick={addWorkspace} disabled={action !== null}>
                {action === "add" ? <RefreshCw size={14} className="spin" /> : <FolderOpen size={14} />}
                {preview.relinkWorkspaceId ? l("Relink and import", "重新关联并导入") : l("Manage and import", "开始管理并导入")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function CircleStopIcon(): ReactElement {
  return <span className="openviking-stop-icon" aria-hidden="true" />;
}

function manualIdFromUri(uri: string): string | null {
  const match = /^viking:\/\/user\/memories\/manual\/([A-Za-z0-9_-]+)\.md$/u.exec(uri);
  return match?.[1] ?? null;
}

function importProgress(workspace: OpenVikingWorkspace): string {
  if (workspace.totalTurns <= 0) return workspace.importState === "completed" ? "100%" : "0%";
  return `${Math.min(100, Math.round((workspace.importedTurns / workspace.totalTurns) * 100))}%`;
}

function importLabel(workspace: OpenVikingWorkspace, language: LanguageMode): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  switch (workspace.importState) {
    case "running": return l("Importing and extracting memory", "正在导入并提取记忆");
    case "queued": return l("Queued", "等待导入");
    case "paused": return l("Paused", "已暂停");
    case "failed": return l("Import failed", "导入失败");
    case "completed": return l("Ready", "就绪");
    default: return l("Preparing", "准备中");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
