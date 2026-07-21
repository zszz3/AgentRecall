import type { ReactElement } from "react";
import { Braces, LoaderCircle } from "lucide-react";
import type { AgentMemoryEffectiveContext, AgentMemoryTarget } from "../../../../core/agent-memory-sync";
import { localize, type LanguageMode } from "../../language";

interface AgentMemoryEffectiveViewProps {
  language: LanguageMode;
  target: AgentMemoryTarget;
  context: AgentMemoryEffectiveContext | null;
  loading: boolean;
  onTargetChange(target: AgentMemoryTarget): void;
}

export function AgentMemoryEffectiveView({
  language,
  target,
  context,
  loading,
  onTargetChange,
}: AgentMemoryEffectiveViewProps): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="agent-memory-effective">
      <header>
        <div>
          <strong>{l("Effective context", "最终生效内容")}</strong>
          <span>{l(
            "Project files managed by AgentRecall, ordered from the Git root to the selected directory.",
            "仅展示 AgentRecall 管理的项目文件，并按 Git 根目录到当前目录的顺序合并。",
          )}</span>
        </div>
        <div className="agent-memory-target-tabs" role="tablist" aria-label={l("Target Agent", "目标 Agent")}>
          {(["codex", "claude", "cursor"] as AgentMemoryTarget[]).map((option) => (
            <button
              type="button"
              role="tab"
              aria-selected={target === option}
              className={target === option ? "active" : ""}
              key={option}
              onClick={() => onTargetChange(option)}
            >
              {targetLabel(option)}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className="agent-memory-effective-state"><LoaderCircle className="spin" size={18} />{l("Building context…", "正在合并内容…")}</div>
      ) : context && context.sources.length > 0 ? (
        <>
          <div className="agent-memory-effective-sources">
            <span>{l(`${context.sources.length} sources`, `${context.sources.length} 个来源`)}</span>
            {context.sources.map((source) => <code key={source.relativePath}>{source.relativePath}</code>)}
          </div>
          <pre>{context.content}</pre>
        </>
      ) : (
        <div className="agent-memory-effective-state">
          <Braces size={20} />
          <strong>{l(`No managed context for ${targetLabel(target)}`, `${targetLabel(target)} 暂无生效内容`)}</strong>
          <span>{l("Create or sync a memory file in this directory chain.", "可以在这条目录链中新建或同步记忆文件。")}</span>
        </div>
      )}
    </div>
  );
}

function targetLabel(target: AgentMemoryTarget): string {
  if (target === "codex") return "Codex";
  if (target === "claude") return "Claude Code";
  return "Cursor";
}
