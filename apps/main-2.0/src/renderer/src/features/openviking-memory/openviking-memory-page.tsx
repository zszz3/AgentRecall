import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  BookOpen,
  ChevronDown,
  ChevronRight,
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
import { isOpenVikingMemoryTransient } from "../../../../core/openviking-memory-lifecycle";
import type {
  OpenVikingDirectoryPreview,
  OpenVikingImportSessionPreview,
} from "../../../../main/services/openviking-memory-service";
import { localize, type LanguageMode } from "../../language";
import {
  groupOpenVikingMemories,
  type OpenVikingMemoryCategory,
} from "./openviking-memory-groups";
import { OpenVikingRuntimeMonitor } from "./openviking-runtime-monitor";

type MemoryView = "memory" | "runtime";

type PageAction =
  | "choose"
  | "add"
  | "list-import-sessions"
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
  const [activeView, setActiveView] = useState<MemoryView>("memory");
  const [snapshot, setSnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenVikingDirectoryPreview | null>(null);
  const [importPickerWorkspace, setImportPickerWorkspace] = useState<OpenVikingWorkspace | null>(null);
  const [importSessions, setImportSessions] = useState<OpenVikingImportSessionPreview[]>([]);
  const [importSessionQuery, setImportSessionQuery] = useState("");
  const [selectedImportSessionKeys, setSelectedImportSessionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVikingMemoryItem[]>([]);
  const [selected, setSelected] = useState<OpenVikingMemoryItem | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [action, setAction] = useState<PageAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const browseRequestVersion = useRef(0);
  const previousBrowseAction = useRef<PageAction>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<
    Set<OpenVikingMemoryCategory>
  >(() => new Set());

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

  const transient = isOpenVikingMemoryTransient(snapshot, action === "import");

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
  const runtimeRunning = snapshot?.runtime.state === "running";
  const memoryGroups = useMemo(() => groupOpenVikingMemories(results), [results]);
  const visibleImportSessions = useMemo(() => {
    const normalizedQuery = importSessionQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return importSessions;
    return importSessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(normalizedQuery)
      || session.source.toLocaleLowerCase().includes(normalizedQuery));
  }, [importSessionQuery, importSessions]);

  useEffect(() => {
    setCollapsedCategories(new Set());
  }, [results, workspaceId]);

  useEffect(() => {
    const previousAction = previousBrowseAction.current;
    previousBrowseAction.current = action;
    if (action === "read" || previousAction === "read") return;
    if (
      !enabled
      || !workspace
      || query.trim()
      || action === "import"
      || snapshot?.runtime.state !== "running"
    ) {
      setBrowseLoading(false);
      return;
    }
    const requestVersion = ++browseRequestVersion.current;
    let current = true;
    setBrowseLoading(true);
    void window.sessionSearch.searchOpenVikingMemories(workspace.id, "", 200)
      .then((memories) => {
        if (current && browseRequestVersion.current === requestVersion) setResults(memories);
      })
      .catch((cause) => {
        if (current && browseRequestVersion.current === requestVersion) setError(errorMessage(cause));
      })
      .finally(() => {
        if (current && browseRequestVersion.current === requestVersion) setBrowseLoading(false);
      });
    return () => {
      current = false;
    };
  }, [action, enabled, query, snapshot?.runtime.state, workspace?.id, workspace?.importState]);

  const ready = snapshot?.runtime.state !== "not-installed" && snapshot?.model.installed;
  const editableMemoryUri = selected ? editableUriForMemory(selected.id) : null;
  const identityMemory = selected ? isIdentityMemory(selected.id) : false;
  const canEditSelected = Boolean(selected && (!selected.id || editableMemoryUri));

  const toggleCategory = (category: OpenVikingMemoryCategory) => {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const run = async (nextAction: Exclude<PageAction, null>, operation: () => Promise<void>) => {
    setAction(nextAction);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (!isOpenVikingPausedError(cause)) setError(errorMessage(cause));
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
      await openImportPicker(added);
    });
  };

  const openImportPicker = async (target: OpenVikingWorkspace) => {
    setAction("list-import-sessions");
    setError(null);
    try {
      const sessions = await window.sessionSearch.listOpenVikingImportSessions(target.id);
      setImportPickerWorkspace(target);
      setImportSessions(sessions);
      setImportSessionQuery("");
      setSelectedImportSessionKeys(new Set());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const toggleImportSession = (session: OpenVikingImportSessionPreview) => {
    if (!isImportSessionSelectable(session)) return;
    setSelectedImportSessionKeys((current) => {
      const next = new Set(current);
      if (next.has(session.sessionKey)) next.delete(session.sessionKey);
      else next.add(session.sessionKey);
      return next;
    });
  };

  const selectVisibleImportSessions = () => {
    setSelectedImportSessionKeys((current) => {
      const next = new Set(current);
      for (const session of visibleImportSessions) {
        if (isImportSessionSelectable(session)) next.add(session.sessionKey);
      }
      return next;
    });
  };

  const beginSelectedImport = () => {
    if (!importPickerWorkspace || selectedImportSessionKeys.size === 0) return;
    const target = importPickerWorkspace;
    const selectedKeys = [...selectedImportSessionKeys];
    setImportPickerWorkspace(null);
    browseRequestVersion.current += 1;
    setBrowseLoading(false);
    setAction("import");
    setError(null);
    void window.sessionSearch.importOpenVikingWorkspace(target.id, selectedKeys)
      .catch((cause) => setError(errorMessage(cause)))
      .finally(async () => {
        try {
          await refresh();
        } catch (cause) {
          setError(errorMessage(cause));
        } finally {
          setAction(null);
        }
      });
    void refresh().catch((cause) => setError(errorMessage(cause)));
  };

  const startImport = (target: OpenVikingWorkspace, resume: boolean) => {
    browseRequestVersion.current += 1;
    setBrowseLoading(false);
    setAction("import");
    setError(null);
    const request = resume
      ? window.sessionSearch.resumeOpenVikingImport(target.id)
      : window.sessionSearch.pauseOpenVikingImport(target.id);
    void request
      .catch((cause) => setError(errorMessage(cause)))
      .finally(async () => {
        try {
          await refresh();
        } catch (cause) {
          setError(errorMessage(cause));
        } finally {
          setAction(null);
        }
      });
    void refresh().catch((cause) => setError(errorMessage(cause)));
  };

  const search = () => {
    if (!workspace || !runtimeRunning || !query.trim()) return;
    void run("search", async () => {
      const next = await window.sessionSearch.searchOpenVikingMemories(workspace.id, query.trim(), 30);
      setResults(next);
      setSelected(null);
    });
  };

  const openMemory = (memory: OpenVikingMemoryItem) => run("read", async () => {
    if (!runtimeRunning && !memory.content) return;
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
    if (!workspace || !runtimeRunning) return;
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
    if (!workspace || !runtimeRunning || !selected || !canEditSelected || !draftTitle.trim()) return;
    void run("save", async () => {
      const saved = await window.sessionSearch.saveOpenVikingMemory(workspace.id, {
        ...(editableMemoryUri ? { uri: editableMemoryUri } : {}),
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
    if (!workspace || !runtimeRunning || !selected?.id) return;
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
      browseRequestVersion.current += 1;
      setBrowseLoading(false);
      try {
        await window.sessionSearch.deleteOpenVikingWorkspace(workspace.id);
      } finally {
        setResults([]);
        setSelected(null);
        await refresh();
      }
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

  if (activeView === "runtime") {
    return (
      <div className="openviking-memory-page">
        <header className="app-page-head openviking-page-head">
          <div>
            <h2>{l("Memory", "记忆")}</h2>
            <p>{l(
              "Observe and control the local OpenViking memory runtime.",
              "观测并控制本机的 OpenViking 记忆服务。",
            )}</p>
          </div>
        </header>
        <OpenVikingMemoryTabs
          activeView={activeView}
          language={language}
          onChange={setActiveView}
        />
        <OpenVikingRuntimeMonitor language={language} />
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
          <button
            type="button"
            onClick={() => void run("refresh", async () => { await refresh(); })}
            disabled={action === "refresh"}
          >
            <RefreshCw size={14} className={action === "refresh" ? "spin" : ""} />{l("Refresh", "刷新")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void chooseDirectory()}
            disabled={!ready || action === "choose" || action === "add"}
          >
            <FolderOpen size={14} />{l("Manage directory", "管理目录")}
          </button>
        </div>
      </header>

      <OpenVikingMemoryTabs
        activeView={activeView}
        language={language}
        onChange={setActiveView}
      />

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
          <button type="button" onClick={() => void chooseDirectory()} disabled={!ready || action === "choose" || action === "add"}>
            <Plus size={14} />{l("Add directory", "添加目录")}
          </button>
        </section>
      ) : (
        <div className="openviking-memory-layout">
          <aside className="openviking-workspaces">
            <header>
              <strong>{l("Directories", "目录")}</strong>
              <button type="button" onClick={() => void chooseDirectory()} disabled={!ready || action === "choose" || action === "add"} aria-label={l("Add directory", "添加目录")}>
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
                    ) : workspace.importState === "paused" && workspace.managed ? (
                      <button type="button" onClick={() => startImport(workspace, true)} disabled={action !== null}>
                        <Play size={13} />{l("Resume import", "继续导入")}
                      </button>
                    ) : null}
                    {workspace.managed ? (
                      <button
                        type="button"
                        onClick={() => void openImportPicker(workspace)}
                        disabled={action !== null && action !== "import"}
                      >
                        <Plus size={13} />{l("Select sessions", "选择导入")}
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

                <div className={`openviking-import-status ${workspace.importState}`}>
                  <div className="openviking-import-status-head">
                    <span className="openviking-import-live" aria-hidden="true" />
                    <strong>{importActivityLabel(workspace, language)}</strong>
                    {workspace.importActivity?.sessionTitle ? (
                      <span title={workspace.importActivity.sessionTitle}>
                        {workspace.importActivity.sessionTitle}
                      </span>
                    ) : null}
                    {workspace.importActivity?.currentSession !== undefined
                      && workspace.importActivity.totalSessions !== undefined ? (
                        <em>{l(
                          `Session ${workspace.importActivity.currentSession} / ${workspace.importActivity.totalSessions}`,
                          `会话 ${workspace.importActivity.currentSession} / ${workspace.importActivity.totalSessions}`,
                        )}</em>
                      ) : null}
                    {workspace.importActivity?.currentBatch !== undefined
                      && workspace.importActivity.totalBatches !== undefined ? (
                        <em>{l(
                          `Batch ${workspace.importActivity.currentBatch} / ${workspace.importActivity.totalBatches}`,
                          `批次 ${workspace.importActivity.currentBatch} / ${workspace.importActivity.totalBatches}`,
                        )}</em>
                      ) : null}
                  </div>
                  <div className="openviking-import-track"><i
                    className={workspace.importState === "running" ? "active" : ""}
                    style={{ width: importProgress(workspace) }}
                  /></div>
                  <div className="openviking-import-status-foot">
                    <span>{l(
                      `Imported ${workspace.importedTurns} / ${workspace.totalTurns}`,
                      `已导入 ${workspace.importedTurns} / ${workspace.totalTurns}`,
                    )}</span>
                    {(workspace.totalTasks ?? 0) > 0 ? (
                      <span>{l(
                        `Tasks ${workspace.completedTasks ?? 0} / ${workspace.totalTasks}`,
                        `任务 ${workspace.completedTasks ?? 0} / ${workspace.totalTasks}`,
                      )}</span>
                    ) : null}
                    <em>{importProgress(workspace)}</em>
                  </div>
                </div>

                <form className="openviking-search" onSubmit={(event) => { event.preventDefault(); search(); }}>
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    readOnly={!runtimeRunning}
                    placeholder={l("Search this directory's memory", "搜索当前目录的记忆")}
                  />
                  <button type="submit" disabled={!query.trim() || action !== null || snapshot.runtime.state !== "running"}>{l("Search", "搜索")}</button>
                  <button type="button" onClick={newMemory} disabled={!runtimeRunning || !workspace.managed || action !== null}>
                    <Plus size={13} />{l("New", "新建")}
                  </button>
                </form>

                <div className="openviking-memory-content">
                  <div className="openviking-result-list">
                    {browseLoading ? (
                      <div className="openviking-result-empty">{l(
                        "Loading existing memories…",
                        "正在加载已有记忆…",
                      )}</div>
                    ) : results.length === 0 ? (
                      <div className="openviking-result-empty">{l(
                        query.trim()
                          ? "No matching memories."
                          : workspace.importState === "completed"
                            ? "No memories have been generated yet."
                            : "Generated memories will appear here.",
                        query.trim()
                          ? "没有匹配的记忆。"
                          : workspace.importState === "completed"
                            ? "还没有生成记忆。"
                            : "生成的记忆会显示在这里。",
                      )}</div>
                    ) : memoryGroups.map((group) => {
                      const isCollapsed = collapsedCategories.has(group.key);
                      return (
                        <section className="openviking-result-group" key={group.key}>
                          <button
                            type="button"
                            className="openviking-result-group-head"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleCategory(group.key)}
                          >
                            <span aria-hidden="true">
                              {isCollapsed
                                ? <ChevronRight size={13} />
                                : <ChevronDown size={13} />}
                            </span>
                            <strong>{l(group.label.en, group.label.zh)}</strong>
                            <em>{group.memories.length}</em>
                          </button>
                          {!isCollapsed ? (
                            <div className="openviking-result-group-body">
                              {group.memories.map((memory) => (
                                <button
                                  type="button"
                                  key={memory.id}
                                  className={selected?.id === memory.id ? "active" : ""}
                                  disabled={!runtimeRunning && !memory.content}
                                  onClick={() => void openMemory(memory)}
                                >
                                  <strong>{memory.title}</strong>
                                  <span>{memory.content || memory.source || memory.id}</span>
                                  {memory.score !== undefined
                                    ? <em>{memory.score.toFixed(2)}</em>
                                    : null}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
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
                          readOnly={!runtimeRunning || !canEditSelected}
                          onChange={(event) => setDraftTitle(event.currentTarget.value)}
                          placeholder={l("Title", "标题")}
                        />
                        <textarea
                          value={draftContent}
                          readOnly={!runtimeRunning || !canEditSelected}
                          onChange={(event) => setDraftContent(event.currentTarget.value)}
                          placeholder={l("What should agents remember?", "希望 Agent 记住什么？")}
                        />
                        <footer>
                          <span>{
                            identityMemory
                              ? l("Identity memory", "身份记忆")
                              : canEditSelected
                                ? l("Manual memory", "手动记忆")
                                : l("Generated memory · read only", "自动生成的记忆 · 只读")
                          }</span>
                          <div>
                            {selected.id ? (
                              <button type="button" className="danger" onClick={deleteMemory} disabled={!runtimeRunning || action !== null}>
                                <Trash2 size={13} />{l("Delete", "删除")}
                              </button>
                            ) : null}
                            {canEditSelected ? (
                              <button type="button" className="primary" onClick={saveMemory} disabled={!runtimeRunning || !draftTitle.trim() || action !== null}>
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
              <span><strong>{preview.sessionCount}</strong>{l(" sessions can be selected after managing", " 个会话可在开始管理后选择导入")}</span>
              <span>{l("Memory remains isolated from every other directory.", "记忆将与其他所有目录保持隔离。")}</span>
              {preview.existingWorkspaceId ? <span>{l("This directory already has a retained workspace.", "这个目录已有保留的 workspace，将恢复管理。")}</span> : null}
            </div>
            <footer>
              <button type="button" onClick={() => setPreview(null)}>{l("Cancel", "取消")}</button>
              <button type="button" className="primary" onClick={addWorkspace} disabled={action !== null}>
                {action === "add" ? <RefreshCw size={14} className="spin" /> : <FolderOpen size={14} />}
                {preview.relinkWorkspaceId ? l("Relink directory", "重新关联目录") : l("Manage directory", "开始管理")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {importPickerWorkspace ? (
        <div className="openviking-preview-backdrop" onMouseDown={() => setImportPickerWorkspace(null)}>
          <section className="openviking-preview-dialog openviking-import-picker" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h3>{l("Select sessions to import", "选择要导入的会话")}</h3>
                <p>{importPickerWorkspace.rootPath}</p>
              </div>
              <button type="button" onClick={() => setImportPickerWorkspace(null)}><X size={15} /></button>
            </header>
            <div className="openviking-import-picker-tools">
              <label>
                <Search size={14} />
                <input
                  value={importSessionQuery}
                  onChange={(event) => setImportSessionQuery(event.currentTarget.value)}
                  placeholder={l("Search session title or source", "搜索会话标题或来源")}
                  autoFocus
                />
              </label>
              <button type="button" onClick={selectVisibleImportSessions}>
                {l("Select visible", "全选当前结果")}
              </button>
              <button type="button" onClick={() => setSelectedImportSessionKeys(new Set())}>
                {l("Clear", "清空")}
              </button>
            </div>
            <div className="openviking-import-session-list">
              {visibleImportSessions.length > 0 ? visibleImportSessions.map((session) => (
                <label className={!isImportSessionSelectable(session) ? "disabled" : ""} key={session.sessionKey}>
                  <input
                    type="checkbox"
                    checked={selectedImportSessionKeys.has(session.sessionKey)}
                    disabled={!isImportSessionSelectable(session)}
                    onChange={() => toggleImportSession(session)}
                  />
                  <span>
                    <strong title={session.title}>{session.title}</strong>
                    <small>
                      {session.source} · {l(`${session.messageCount} messages`, `${session.messageCount} 条消息`)} · {formatImportSessionTime(session.lastActivityAt, language)}
                    </small>
                  </span>
                  <em className={session.state}>{importSessionStateLabel(session.state, language)}</em>
                </label>
              )) : (
                <div className="openviking-import-session-empty">
                  {l("No matching sessions", "没有匹配的会话")}
                </div>
              )}
            </div>
            <footer>
              <span>{l(
                `${selectedImportSessionKeys.size} selected`,
                `已选择 ${selectedImportSessionKeys.size} 个会话`,
              )}</span>
              <div>
                <button type="button" onClick={() => setImportPickerWorkspace(null)}>{l("Cancel", "取消")}</button>
                <button type="button" className="primary" onClick={beginSelectedImport} disabled={selectedImportSessionKeys.size === 0}>
                  <Play size={14} />{l("Start import", "开始导入")}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function OpenVikingMemoryTabs({
  activeView,
  language,
  onChange,
}: {
  activeView: MemoryView;
  language: LanguageMode;
  onChange: (view: MemoryView) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <nav className="openviking-memory-tabs" aria-label={l("Memory views", "记忆视图")}>
      <button
        type="button"
        className={activeView === "memory" ? "active" : ""}
        aria-current={activeView === "memory" ? "page" : undefined}
        onClick={() => onChange("memory")}
      >
        <BookOpen size={14} />{l("Memories", "记忆")}
      </button>
      <button
        type="button"
        className={activeView === "runtime" ? "active" : ""}
        aria-current={activeView === "runtime" ? "page" : undefined}
        onClick={() => onChange("runtime")}
      >
        <Activity size={14} />{l("Runtime monitor", "运行监控")}
      </button>
    </nav>
  );
}

function importSessionStateLabel(
  state: OpenVikingImportSessionPreview["state"],
  language: LanguageMode,
): string {
  if (state === "new") return localize(language, "Not imported", "未导入");
  if (state === "changed") return localize(language, "Updated", "有更新");
  if (state === "importing") return localize(language, "Importing", "导入中");
  return localize(language, "Imported", "已导入");
}

function isImportSessionSelectable(session: OpenVikingImportSessionPreview): boolean {
  return session.state === "new" || session.state === "changed";
}

function formatImportSessionTime(timestamp: number, language: LanguageMode): string {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function CircleStopIcon(): ReactElement {
  return <span className="openviking-stop-icon" aria-hidden="true" />;
}

function editableUriForMemory(uri: string): string | null {
  return /^viking:\/\/user\/memories\/(?:(?:identity|soul)\.md|manual\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md)$/u.test(uri)
    ? uri
    : null;
}

function isIdentityMemory(uri: string): boolean {
  const candidate = uri.split("/").at(-1)?.toLowerCase();
  return candidate === "identity.md" || candidate === "soul.md";
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

function importActivityLabel(workspace: OpenVikingWorkspace, language: LanguageMode): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  switch (workspace.importActivity?.phase) {
    case "scanning": return l("Scanning importable sessions", "正在扫描可导入的会话");
    case "uploading": return l("Sending session content", "正在传送会话内容");
    case "extracting": return l("Extracting memory from this session", "正在提取当前会话的记忆");
    default: return importLabel(workspace, language);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpenVikingPausedError(error: unknown): boolean {
  return errorMessage(error).includes("OpenViking is paused");
}
