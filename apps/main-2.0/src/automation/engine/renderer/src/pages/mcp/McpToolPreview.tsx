import { useEffect } from "react";
import { X } from "lucide-react";
import type { Language } from "../../app/language";
import type { McpToolDefinition } from "../../../../shared/mcp/types";

export function McpToolPreview({
  language = "en",
  tool,
  disabled,
  onClose,
}: {
  language?: Language;
  tool: McpToolDefinition;
  disabled: boolean;
  onClose: () => void;
}) {
  const zh = language === "zh";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mcp-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tool.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mcp-modal-header">
          <div className="mcp-modal-title">
            <code>{tool.name}</code>
            <span className={`mcp-tool-state is-${disabled ? "off" : "on"}`}>
              {disabled ? (zh ? "已禁用" : "Disabled") : (zh ? "已启用" : "Enabled")}
            </span>
          </div>
          <button
            className="icon-btn"
            type="button"
            aria-label={zh ? "关闭" : "Close"}
            title={zh ? "关闭" : "Close"}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <div className="mcp-modal-body">
          <section className="mcp-modal-section">
            <span className="mcp-modal-label">{zh ? "描述" : "Description"}</span>
            <p className="mcp-modal-description">
              {tool.description || (zh ? "无描述" : "No description")}
            </p>
          </section>
          <section className="mcp-modal-section">
            <span className="mcp-modal-label">{zh ? "输入参数 Schema" : "Input schema"}</span>
            <pre className="mcp-schema-view">
              {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}
