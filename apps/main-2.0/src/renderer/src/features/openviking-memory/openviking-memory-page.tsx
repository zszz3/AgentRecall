import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";

import type {
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
} from "../../../../core/openviking-memory";
import type {
  OpenVikingMemoryDetails,
  OpenVikingMemoryFeedbackKind,
} from "../../../../core/openviking-memory-control";
import { isOpenVikingMemoryTransient } from "../../../../core/openviking-memory-lifecycle";
import type { OpenVikingDirectoryPreview } from "../../../../main/services/openviking-memory-service";
import { localize, type LanguageMode } from "../../language";
import {
  groupOpenVikingMemories,
  type OpenVikingMemoryCategory,
} from "./openviking-memory-groups";
import { tryCanonicalOpenVikingMemoryUri } from "./openviking-memory-uri";
import { OpenVikingRuntimeMonitor } from "./openviking-runtime-monitor";

type MemoryView = "memory" | "runtime";

type PageAction =
  | "choose"
  | "add"
  | "refresh"
  | "search"
  | "read"
  | "save"
  | "delete-memory"
  | "feedback"
  | "stop"
  | "delete-workspace"
  | null;

export function OpenVikingMemoryPage({
  language,
  enabled,
  onOpenSettings,
  onViewSession,
}: {
  language: LanguageMode;
  enabled: boolean;
  onOpenSettings: () => void;
  onViewSession?: (rawId: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [activeView, setActiveView] = useState<MemoryView>("memory");
  const [snapshot, setSnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenVikingDirectoryPreview | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVikingMemoryItem[]>([]);
  const [selected, setSelected] = useState<OpenVikingMemoryItem | null>(null);
  const [details, setDetails] = useState<OpenVikingMemoryDetails | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [action, setAction] = useState<PageAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const browseRequestVersion = useRef(0);
  const memoryReadRequestVersion = useRef(0);
  const workspaceSelectionVersion = useRef(0);
  const lastReadWorkspaceSelectionVersion = useRef(0);
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

  const transient = isOpenVikingMemoryTransient(snapshot);

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
  const memoryTimeFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === "zh" ? "zh-CN" : "en",
    { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  ), [language]);
  const fullMemoryTimeFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === "zh" ? "zh-CN" : "en-US",
    { dateStyle: "medium", timeStyle: "medium" },
  ), [language]);

  useEffect(() => {
    setCollapsedCategories(new Set());
  }, [results, workspaceId]);

  useEffect(() => {
    const previousAction = previousBrowseAction.current;
    previousBrowseAction.current = action;
    if (action === "read") return;
    if (
      previousAction === "read"
      && lastReadWorkspaceSelectionVersion.current === workspaceSelectionVersion.current
    ) return;
    if (
      !enabled
      || !workspace
      || query.trim()
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
  }, [action, enabled, query, snapshot?.runtime.state, workspace?.id]);

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

  const resumeTracking = () => {
    if (!workspace) return;
    void run("add", async () => {
      const resumed = await window.sessionSearch.addOpenVikingWorkspace(workspace.rootPath);
      setWorkspaceId(resumed.id);
      await refresh();
    });
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
    const requestVersion = ++memoryReadRequestVersion.current;
    lastReadWorkspaceSelectionVersion.current = workspaceSelectionVersion.current;
    const [content, memoryDetails] = await Promise.all([
      runtimeRunning
        ? window.sessionSearch.readOpenVikingMemory(memory.workspaceId, memory.id)
        : Promise.resolve(memory.content),
      window.sessionSearch.getOpenVikingMemoryDetails(memory.workspaceId, memory.id),
    ]);
    if (requestVersion !== memoryReadRequestVersion.current) return;
    const next = { ...memory, content };
    setSelected(next);
    setDetails(memoryDetails);
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
    setDetails(null);
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
      setDetails(await window.sessionSearch.getOpenVikingMemoryDetails(workspace.id, saved.id));
      setDraftTitle(saved.title);
      setDraftContent(saved.content);
      setResults(await window.sessionSearch.searchOpenVikingMemories(
        workspace.id,
        query.trim(),
        query.trim() ? 30 : 200,
      ));
    });
  };

  const deleteMemory = () => {
    if (!workspace || !runtimeRunning || !selected?.id) return;
    if (!window.confirm(l("Delete this memory permanently?", "永久删除这条记忆？"))) return;
    void run("delete-memory", async () => {
      await window.sessionSearch.deleteOpenVikingMemory(workspace.id, selected.id);
      setResults((current) => current.filter((item) => item.id !== selected.id));
      setSelected(null);
      setDetails(null);
    });
  };

  const feedbackMemory = (feedback: OpenVikingMemoryFeedbackKind) => {
    if (!workspace || !selected?.id) return;
    void run("feedback", async () => {
      const control = await window.sessionSearch.sendOpenVikingMemoryFeedback(
        workspace.id,
        selected.id,
        feedback,
      );
      const next = {
        ...selected,
        authority: control.authority,
        lifecycle: control.lifecycle,
        locked: control.locked,
        evidenceStatus: control.evidenceStatus,
        evidenceCount: control.evidenceCount,
      };
      setSelected(next);
      setDetails(await window.sessionSearch.getOpenVikingMemoryDetails(workspace.id, selected.id));
      setResults((current) => current.map((item) => item.id === selected.id ? next : item));
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
          <p>{l(
            "Managed directories track new agent turns incrementally and keep memory isolated.",
            "受管理目录会增量跟踪新的 Agent 对话，并保持记忆彼此隔离。",
          )}</p>
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
                    if (item.id === workspaceId) return;
                    memoryReadRequestVersion.current += 1;
                    workspaceSelectionVersion.current += 1;
                    setWorkspaceId(item.id);
                    setQuery("");
                    setResults([]);
                    setSelected(null);
                    setDetails(null);
                  }}
                >
                  <FolderOpen size={15} />
                  <span>
                    <strong>{item.displayName}</strong>
                    <small title={item.rootPath}>{item.rootPath}</small>
                  </span>
                  <em className={item.managed ? "tracking" : "stopped"}>
                    {item.managed ? l("Tracking", "跟踪中") : l("Stopped", "已停止")}
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
                    {workspace.managed ? (
                      <button type="button" onClick={stopManaging} disabled={action !== null}>
                        <CircleStopIcon />{l("Stop managing", "停止管理")}
                      </button>
                    ) : (
                      <button type="button" onClick={resumeTracking} disabled={action !== null}>
                        <Plus size={13} />{l("Resume tracking", "恢复跟踪")}
                      </button>
                    )}
                    <button type="button" className="danger" onClick={deleteWorkspace} disabled={action !== null}>
                      <Trash2 size={13} />{l("Delete data", "删除数据")}
                    </button>
                  </div>
                </header>

                <div className={`openviking-tracking-status ${workspace.managed ? "tracking" : "stopped"}`}>
                  <span className="openviking-tracking-dot" aria-hidden="true" />
                  <div>
                    <strong>{workspace.managed
                      ? l("Incremental tracking is enabled", "已启用增量跟踪")
                      : l("Incremental tracking is stopped", "增量跟踪已停止")}</strong>
                    <span>{workspace.managed
                      ? l(
                        "New turns created inside this directory are captured automatically. Historical AgentRecall sessions are never bulk-imported.",
                        "此目录中新产生的对话会被自动捕获；AgentRecall 中的历史会话不会被批量导入。",
                      )
                      : l(
                        "Existing memory remains available, but new agent turns are not captured until tracking resumes.",
                        "已有记忆仍然保留，但在恢复跟踪前不会捕获新的 Agent 对话。",
                      )}</span>
                    {workspace.managed ? <small>{l(
                      "Turns are appended first. After enough context accumulates, you explicitly ask to remember something, or the session closes, OpenViking runs model-based extraction in the background and may finish later.",
                      "新对话会先增量追加；上下文达到阈值、你明确要求记住内容或会话结束后，OpenViking 才会在后台运行模型提炼，完成时间可能更晚。",
                    )}</small> : null}
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
                          : "No memories have been generated yet.",
                        query.trim()
                          ? "没有匹配的记忆。"
                          : "还没有生成记忆。",
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
                              {group.memories.map((memory) => {
                                const updatedAt = memory.updatedAt ? new Date(memory.updatedAt) : null;
                                const hasUpdatedAt = updatedAt && Number.isFinite(updatedAt.getTime());
                                const fullUpdatedAt = hasUpdatedAt ? fullMemoryTimeFormatter.format(updatedAt) : "";
                                return (
                                  <button
                                    type="button"
                                    key={memory.id}
                                    className={selected?.id === memory.id ? "active" : ""}
                                    disabled={!runtimeRunning && !memory.content}
                                    onClick={() => void openMemory(memory)}
                                  >
                                    <span className="openviking-result-primary">
                                      <strong>{memory.title}</strong>
                                      {hasUpdatedAt ? (
                                        <time
                                          dateTime={memory.updatedAt}
                                          title={fullUpdatedAt}
                                          aria-label={l(`Updated ${fullUpdatedAt}`, `更新于 ${fullUpdatedAt}`)}
                                        >
                                          {memoryTimeFormatter.format(updatedAt)}
                                        </time>
                                      ) : null}
                                    </span>
                                    <span className="openviking-result-secondary">
                                      <span>{memory.content || memory.source || memory.id}</span>
                                      {memory.score !== undefined
                                        ? <em>{memory.score.toFixed(2)}</em>
                                        : null}
                                    </span>
                                  </button>
                                );
                              })}
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
                        {selected.id ? (
                          <div className="openviking-memory-control-meta">
                            <span className={selected.locked ? "locked" : ""}>
                              <ShieldCheck size={12} />
                              {selected.locked ? l("User locked", "用户锁定") : l("Automatic", "自动维护")}
                            </span>
                            <span>{l("Authority", "权威")}: {selected.authority ?? "model"}</span>
                            <span>{l("State", "状态")}: {selected.lifecycle ?? "active"}</span>
                            <span>{l("Evidence", "证据")}: {selected.evidenceStatus ?? "legacy"} · {selected.evidenceCount ?? 0}</span>
                          </div>
                        ) : null}
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
                                ? selected.id
                                  ? l("Saving creates a locked user version", "保存后生成用户锁定版本")
                                  : l("Manual memory", "手动记忆")
                                : l("Generated memory", "自动生成的记忆")
                          }</span>
                          <div>
                            {selected.id ? (
                              <div className="openviking-memory-feedback-actions">
                                <button type="button" onClick={() => feedbackMemory("helpful")} disabled={action !== null}>
                                  <ThumbsUp size={12} />{l("Helpful", "有用")}
                                </button>
                                <button type="button" onClick={() => feedbackMemory("outdated")} disabled={action !== null}>
                                  <ThumbsDown size={12} />{l("Outdated", "已过时")}
                                </button>
                                <button type="button" onClick={() => feedbackMemory("wrong")} disabled={action !== null}>
                                  <X size={12} />{l("Wrong", "错误")}
                                </button>
                              </div>
                            ) : null}
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
                        {details?.evidence.length ? (
                          <div className="openviking-memory-evidence">
                            <strong>{l("Evidence", "证据")}</strong>
                            {details.evidence.slice(0, 4).map((evidence) => (
                              <button
                                key={evidence.id}
                                type="button"
                                className="openviking-evidence-item"
                                disabled={!evidence.sourceSessionId || !onViewSession}
                                title={evidence.sourceSessionId ? l("View session", "查看会话") : undefined}
                                onClick={() => evidence.sourceSessionId && onViewSession?.(evidence.sourceSessionId)}
                              >
                                <em>{evidence.sourceAgent === "claude" ? "Claude Code" : evidence.sourceAgent === "codex" ? "Codex" : evidence.sourceAgent ?? l("Unknown", "未知")}</em>
                                <span>
                                  {evidence.sourceTurnIds.length > 0
                                    ? l(`${evidence.sourceTurnIds.length} turns`, `${evidence.sourceTurnIds.length} 个 turn`)
                                    : null}
                                </span>
                                {evidence.sourceSessionId ? <code title={evidence.sourceSessionId}>{evidence.sourceSessionId.slice(0, 8)}</code> : null}
                                <small>{new Date(evidence.createdAt).toLocaleDateString(language === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric" })}</small>
                              </button>
                            ))}
                          </div>
                        ) : null}
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
              <span>{l(
                "Only new agent turns created after tracking starts are sent to OpenViking.",
                "只有开始跟踪后新产生的 Agent 对话会发送给 OpenViking。",
              )}</span>
              <span>{l(
                "Historical sessions stay searchable in AgentRecall and are never bulk-imported into memory.",
                "历史会话仍可在 AgentRecall 中搜索，但不会被批量导入记忆。",
              )}</span>
              <span>{l(
                "For reusable history, locate it with session search, then save it manually or ask the agent to remember it.",
                "需要复用历史信息时，可先通过会话搜索定位，再手动保存或让 Agent 明确记住。",
              )}</span>
              <span>{l("Memory remains isolated from every other directory.", "记忆将与其他所有目录保持隔离。")}</span>
              {preview.existingWorkspaceId ? <span>{l("This directory already has a retained workspace.", "这个目录已有保留的 workspace，将恢复管理。")}</span> : null}
            </div>
            <footer>
              <button type="button" onClick={() => setPreview(null)}>{l("Cancel", "取消")}</button>
              <button type="button" className="primary" onClick={addWorkspace} disabled={action !== null}>
                {action === "add" ? <RefreshCw size={14} className="spin" /> : <FolderOpen size={14} />}
                {preview.relinkWorkspaceId ? l("Relink directory", "重新关联目录") : l("Start tracking", "开始跟踪")}
              </button>
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

function CircleStopIcon(): ReactElement {
  return <span className="openviking-stop-icon" aria-hidden="true" />;
}

function editableUriForMemory(uri: string): string | null {
  return tryCanonicalOpenVikingMemoryUri(uri);
}

function isIdentityMemory(uri: string): boolean {
  const candidate = uri.split("/").at(-1)?.toLowerCase();
  return candidate === "identity.md" || candidate === "soul.md";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
