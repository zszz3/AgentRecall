import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
  X,
} from "lucide-react";
import type {
  AgentMemoryDocument,
  AgentMemoryFile,
  AgentMemoryKind,
  AgentMemorySnapshot,
} from "../../../../core/agent-memory";
import type {
  AgentMemoryEffectiveContext,
  AgentMemorySyncPreview,
  AgentMemoryTarget,
} from "../../../../core/agent-memory-sync";
import { localize, type LanguageMode } from "../../language";
import { AgentMemoryEffectiveView } from "./agent-memory-effective-view";
import { AgentMemorySyncDialog } from "./agent-memory-sync-dialog";

type MemoryFeedback = { kind: "error" | "success"; message: string } | null;
type MemoryBusy = "choose" | "refresh" | "read" | "save" | "create" | "sync-preview" | "sync-apply" | "sync-undo" | null;

export function AgentMemoryPage({ language }: { language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [document, setDocument] = useState<AgentMemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<MemoryBusy>(null);
  const [feedback, setFeedback] = useState<MemoryFeedback>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<AgentMemoryKind>("agents");
  const [cursorRuleName, setCursorRuleName] = useState("memory");
  const [editorView, setEditorView] = useState<"file" | "effective">("file");
  const [effectiveTarget, setEffectiveTarget] = useState<AgentMemoryTarget>("codex");
  const [effectiveContext, setEffectiveContext] = useState<AgentMemoryEffectiveContext | null>(null);
  const [effectiveLoading, setEffectiveLoading] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTargets, setSyncTargets] = useState<AgentMemoryTarget[]>(["codex", "claude", "cursor"]);
  const [syncPreview, setSyncPreview] = useState<AgentMemorySyncPreview | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncUndoId, setSyncUndoId] = useState<string | null>(null);
  const readSequence = useRef(0);
  const effectiveSequence = useRef(0);
  const dirty = Boolean(document && draft !== document.content);

  const confirmDiscard = () => !dirty || window.confirm(l("Discard unsaved changes?", "放弃尚未保存的修改？"));

  const openDocument = async (file: AgentMemoryFile, options: { force?: boolean; skipDiscard?: boolean } = {}) => {
    setEditorView("file");
    if (!options.force && document?.relativePath === file.relativePath) return;
    if (!options.skipDiscard && !confirmDiscard()) return;
    const sequence = ++readSequence.current;
    setBusy("read");
    setFeedback(null);
    try {
      const next = await window.sessionSearch.readAgentMemory(file.relativePath);
      if (sequence !== readSequence.current) return;
      setDocument(next);
      setDraft(next.content);
    } catch (error) {
      if (sequence === readSequence.current) setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      if (sequence === readSequence.current) setBusy(null);
    }
  };

  const acceptSnapshot = async (next: AgentMemorySnapshot, preferredPath?: string, forceLoad = false) => {
    setSnapshot(next);
    setEffectiveContext(null);
    const nextFile = next.files.find((file) => file.relativePath === preferredPath)
      ?? next.files.find((file) => file.scopeDirectory === next.selectedDirectory)
      ?? next.files.at(-1)
      ?? null;
    if (nextFile) await openDocument(nextFile, { force: forceLoad, skipDiscard: true });
    else {
      setDocument(null);
      setDraft("");
    }
  };

  useEffect(() => {
    let active = true;
    void window.sessionSearch.refreshAgentMemories()
      .then((next) => {
        if (active && next) void acceptSnapshot(next, undefined, true);
      })
      .catch((error) => {
        if (active) setFeedback({ kind: "error", message: errorMessage(error) });
      });
    return () => {
      active = false;
      readSequence.current += 1;
      effectiveSequence.current += 1;
    };
    // The main process owns the last explicit directory selection. Restore it once when this page mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseDirectory = async () => {
    if (!confirmDiscard()) return;
    setBusy("choose");
    setFeedback(null);
    try {
      const next = await window.sessionSearch.chooseAgentMemoryDirectory();
      if (next) {
        setEditorView("file");
        setSyncUndoId(null);
        await acceptSnapshot(next, undefined, true);
      }
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setFeedback(null);
    try {
      const next = await window.sessionSearch.refreshAgentMemories();
      if (next) await acceptSnapshot(next, document?.relativePath);
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!document || !dirty) return;
    setBusy("save");
    setFeedback(null);
    try {
      const saved = await window.sessionSearch.saveAgentMemory(document.relativePath, draft);
      setDocument(saved);
      setDraft(saved.content);
      const next = await window.sessionSearch.refreshAgentMemories();
      if (next) setSnapshot(next);
      setEffectiveContext(null);
      setSyncUndoId(null);
      setFeedback({ kind: "success", message: l("Memory saved.", "记忆已保存。") });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const createMemory = async () => {
    setBusy("create");
    setFeedback(null);
    try {
      const created = await window.sessionSearch.createAgentMemory({
        kind: createKind,
        ...(createKind === "cursor" ? { fileName: cursorRuleName } : {}),
      });
      const next = await window.sessionSearch.refreshAgentMemories();
      if (next) setSnapshot(next);
      setDocument(created);
      setDraft(created.content);
      setEditorView("file");
      setEffectiveContext(null);
      setSyncUndoId(null);
      setCreateOpen(false);
      setFeedback({ kind: "success", message: l("Memory file created.", "记忆文件已创建。") });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const loadEffectiveContext = async (target: AgentMemoryTarget) => {
    const sequence = ++effectiveSequence.current;
    setEffectiveTarget(target);
    setEffectiveLoading(true);
    setFeedback(null);
    try {
      const context = await window.sessionSearch.getAgentMemoryEffectiveContext(target);
      if (sequence === effectiveSequence.current) setEffectiveContext(context);
    } catch (error) {
      if (sequence === effectiveSequence.current) setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      if (sequence === effectiveSequence.current) setEffectiveLoading(false);
    }
  };

  const showEffectiveContext = () => {
    setEditorView("effective");
    if (effectiveContext?.target !== effectiveTarget) void loadEffectiveContext(effectiveTarget);
  };

  const openSync = () => {
    if (!document || dirty) return;
    setSyncTargets(document.kind === "agents"
      ? ["claude", "cursor"]
      : document.kind === "claude"
        ? ["codex", "cursor"]
        : ["codex", "claude"]);
    setSyncPreview(null);
    setSyncError(null);
    setSyncOpen(true);
  };

  const toggleSyncTarget = (target: AgentMemoryTarget) => {
    setSyncPreview(null);
    setSyncTargets((current) => current.includes(target)
      ? current.filter((item) => item !== target)
      : [...current, target]);
  };

  const previewSync = async () => {
    if (!document || syncTargets.length === 0) return;
    setBusy("sync-preview");
    setSyncError(null);
    try {
      setSyncPreview(await window.sessionSearch.previewAgentMemorySync(document.relativePath, syncTargets));
    } catch (error) {
      setSyncError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const applySync = async () => {
    if (!syncPreview) return;
    setBusy("sync-apply");
    setSyncError(null);
    try {
      const result = await window.sessionSearch.applyAgentMemorySync(syncPreview.id);
      setSnapshot(result.snapshot);
      setEffectiveContext(null);
      setSyncUndoId(result.undoId);
      setSyncOpen(false);
      setSyncPreview(null);
      setFeedback({
        kind: "success",
        message: l(
          `${result.changedPaths.length} memory files synced.`,
          `已同步 ${result.changedPaths.length} 个记忆文件。`,
        ),
      });
    } catch (error) {
      setSyncError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const undoSync = async () => {
    if (!syncUndoId) return;
    setBusy("sync-undo");
    setFeedback(null);
    try {
      const next = await window.sessionSearch.undoAgentMemorySync(syncUndoId);
      setSnapshot(next);
      setEffectiveContext(null);
      setSyncUndoId(null);
      setFeedback({ kind: "success", message: l("The last memory sync was undone.", "已撤销上一次记忆同步。") });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="agent-memory-page">
      <header className="app-page-head agent-memory-page-head">
        <div>
          <h2>Agent Memory</h2>
          <p>{l("Manage the instructions inherited by a working directory.", "按目录管理 Codex、Claude Code 和 Cursor 会继承的长期知识。")}</p>
        </div>
      </header>

      <section className="agent-memory-surface">
        <header className="agent-memory-toolbar">
          <div className="agent-memory-location">
            <FolderOpen size={15} />
            <span title={snapshot?.selectedDirectoryPath}>{snapshot?.selectedDirectoryPath ?? l("No directory selected", "尚未选择目录")}</span>
          </div>
          <div className="agent-memory-toolbar-actions">
            {snapshot ? (
              <>
                <button type="button" onClick={() => { setFeedback(null); setCreateOpen(true); }} disabled={busy !== null}>
                  <Plus size={14} />{l("New memory", "新建记忆")}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void refresh()}
                  disabled={busy !== null}
                  aria-label={l("Refresh directory memory", "刷新目录记忆")}
                  title={l("Refresh directory memory", "刷新目录记忆")}
                >
                  <RefreshCw size={14} className={busy === "refresh" ? "spin" : ""} />
                </button>
              </>
            ) : null}
            <button type="button" className={snapshot ? "" : "primary"} onClick={() => void chooseDirectory()} disabled={busy !== null}>
              <FolderOpen size={14} />{snapshot ? l("Change directory", "更换目录") : l("Choose directory", "选择目录")}
            </button>
          </div>
        </header>

        {feedback ? (
          <div className={`agent-memory-feedback ${feedback.kind}`}>
            <span>{feedback.message}</span>
            {syncUndoId && feedback.kind === "success" ? (
              <button type="button" onClick={() => void undoSync()} disabled={busy !== null}>
                <Undo2 size={12} />{busy === "sync-undo" ? l("Undoing…", "撤销中…") : l("Undo sync", "撤销同步")}
              </button>
            ) : null}
          </div>
        ) : null}

        {!snapshot ? (
          <div className="agent-memory-empty">
            <span><FolderOpen size={22} /></span>
            <h3>{l("Choose the directory you are working in", "选择正在工作的目录")}</h3>
            <p>{l(
              "AgentRecall only checks the path from its Git root to that directory. It does not scan the entire project.",
              "AgentRecall 只检查 Git 根目录到所选目录之间的路径，不会扫描整个项目。",
            )}</p>
            <button type="button" onClick={() => void chooseDirectory()} disabled={busy !== null}>
              <FolderOpen size={14} />{l("Choose directory", "选择目录")}
            </button>
          </div>
        ) : (
          <div className="agent-memory-layout">
            <aside className="agent-memory-context">
              <header>
                <strong>{l("Effective context", "当前生效内容")}</strong>
                <span>{snapshot.files.length}</span>
              </header>
              <div className="agent-memory-scope-list">
                {snapshot.directories.map((directory) => {
                  const files = snapshot.files.filter((file) => file.scopeDirectory === directory);
                  const current = directory === snapshot.selectedDirectory;
                  const inherited = !current;
                  return (
                    <section key={directory || "root"} className={`agent-memory-scope ${current ? "current" : ""}`}>
                      <div className="agent-memory-scope-head">
                        <span className="agent-memory-scope-node">{current ? <Check size={10} /> : null}</span>
                        <div>
                          <strong>{directoryLabel(directory, snapshot.rootPath)}</strong>
                          <small>{directory || "."}</small>
                        </div>
                        {current ? <em>{l("Current", "当前")}</em> : null}
                      </div>
                      <div className="agent-memory-scope-files">
                        {files.map((file) => (
                          <button
                            type="button"
                            key={file.relativePath}
                            className={document?.relativePath === file.relativePath ? "active" : ""}
                            onClick={() => void openDocument(file)}
                          >
                            <FileText size={13} />
                            <span><strong>{file.name}</strong><small>{memoryKindLabel(file.kind, language)}</small></span>
                            {inherited ? <em>{l("Inherited", "继承")}</em> : <ChevronRight size={12} />}
                          </button>
                        ))}
                        {files.length === 0 ? <p>{l("No memory at this level", "这一层没有记忆文件")}</p> : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            </aside>

            <section className="agent-memory-editor">
              <div className="agent-memory-editor-tabs" role="tablist" aria-label={l("Memory view", "记忆视图")}>
                <button type="button" role="tab" aria-selected={editorView === "file"} className={editorView === "file" ? "active" : ""} onClick={() => setEditorView("file")}>
                  <FileText size={12} />{l("File", "文件")}
                </button>
                <button type="button" role="tab" aria-selected={editorView === "effective"} className={editorView === "effective" ? "active" : ""} onClick={showEffectiveContext}>
                  <Check size={12} />{l("Effective", "生效内容")}
                </button>
              </div>
              {editorView === "effective" ? (
                <AgentMemoryEffectiveView
                  language={language}
                  target={effectiveTarget}
                  context={effectiveContext}
                  loading={effectiveLoading}
                  onTargetChange={(target) => void loadEffectiveContext(target)}
                />
              ) : document ? (
                <>
                  <header>
                    <div>
                      <strong>{document.name}</strong>
                      <span title={document.relativePath}>{document.relativePath}</span>
                    </div>
                    <div className="agent-memory-editor-meta">
                      <span data-kind={document.kind}>{memoryKindLabel(document.kind, language)}</span>
                      {document.scopeDirectory !== snapshot.selectedDirectory ? <em>{l("Inherited", "继承")}</em> : null}
                    </div>
                  </header>
                  <textarea
                    aria-label={l("Agent memory content", "Agent 记忆内容")}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
                    disabled={busy === "read"}
                  />
                  <footer>
                    <span>{l(`${draft.length.toLocaleString()} characters`, `${draft.length.toLocaleString()} 个字符`)}</span>
                    <button
                      type="button"
                      onClick={openSync}
                      disabled={dirty || busy !== null}
                      title={dirty ? l("Save changes before syncing.", "请先保存修改再同步。") : l("Sync this memory to Agents", "把这份记忆同步到其他 Agent")}
                    >
                      <ArrowRightLeft size={13} />{l("Sync to…", "同步到…")}
                    </button>
                    <button type="button" onClick={() => setDraft(document.content)} disabled={!dirty || busy !== null}>
                      <RotateCcw size={13} />{l("Reset", "还原")}
                    </button>
                    <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || busy !== null}>
                      <Save size={13} />{busy === "save" ? l("Saving…", "保存中…") : l("Save", "保存")}
                    </button>
                  </footer>
                </>
              ) : (
                <div className="agent-memory-editor-empty">
                  <FileText size={24} />
                  <h3>{l("No memory files in this path", "这条路径上还没有记忆文件")}</h3>
                  <p>{l("Create one in the selected directory to start building project context.", "在当前目录新建一份，让 Agent 下次进入这里时直接获得上下文。")}</p>
                  <button type="button" onClick={() => { setFeedback(null); setCreateOpen(true); }}><Plus size={14} />{l("New memory", "新建记忆")}</button>
                </div>
              )}
            </section>
          </div>
        )}
      </section>

      {createOpen && snapshot ? (
        <div className="agent-memory-dialog-backdrop" role="presentation" onMouseDown={() => busy === null && setCreateOpen(false)}>
          <section className="agent-memory-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-memory-create-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><h3 id="agent-memory-create-title">{l("New memory", "新建记忆")}</h3><p>{snapshot.selectedDirectoryPath}</p></div>
              <button type="button" aria-label={l("Close", "关闭")} onClick={() => setCreateOpen(false)} disabled={busy !== null}><X size={15} /></button>
            </header>
            <div className="agent-memory-kind-options" role="radiogroup" aria-label={l("Memory format", "记忆格式")}>
              {(["agents", "claude", "cursor"] as AgentMemoryKind[]).map((kind) => (
                <button type="button" key={kind} role="radio" aria-checked={createKind === kind} className={createKind === kind ? "active" : ""} onClick={() => setCreateKind(kind)}>
                  <strong>{kind === "agents" ? "AGENTS.md" : kind === "claude" ? "CLAUDE.md" : "Cursor Rule"}</strong>
                  <span>{memoryKindLabel(kind, language)}</span>
                </button>
              ))}
            </div>
            {createKind === "cursor" ? (
              <label className="agent-memory-rule-name">
                <span>{l("Rule file name", "规则文件名")}</span>
                <div><input value={cursorRuleName} onChange={(event) => setCursorRuleName(event.target.value)} autoFocus /><em>.mdc</em></div>
              </label>
            ) : null}
            {feedback?.kind === "error" ? <div className="agent-memory-dialog-error">{feedback.message}</div> : null}
            <footer>
              <button type="button" onClick={() => setCreateOpen(false)} disabled={busy !== null}>{l("Cancel", "取消")}</button>
              <button type="button" className="primary" onClick={() => void createMemory()} disabled={busy !== null || (createKind === "cursor" && !cursorRuleName.trim())}>
                {busy === "create" ? l("Creating…", "创建中…") : l("Create", "创建")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {syncOpen && document ? (
        <AgentMemorySyncDialog
          language={language}
          sourcePath={document.relativePath}
          targets={syncTargets}
          preview={syncPreview}
          busy={busy === "sync-preview" ? "preview" : busy === "sync-apply" ? "apply" : null}
          error={syncError}
          onToggleTarget={toggleSyncTarget}
          onPreview={() => void previewSync()}
          onApply={() => void applySync()}
          onBack={() => { setSyncPreview(null); setSyncError(null); }}
          onClose={() => {
            if (busy === null) {
              setSyncOpen(false);
              setSyncPreview(null);
              setSyncError(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function directoryLabel(directory: string, rootPath: string): string {
  const parts = (directory || rootPath).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? rootPath;
}

function memoryKindLabel(kind: AgentMemoryKind, language: LanguageMode): string {
  if (kind === "agents") return localize(language, "Shared / Codex", "通用 / Codex");
  if (kind === "claude") return "Claude Code";
  return "Cursor";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
