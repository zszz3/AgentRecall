import { useEffect, useState } from "react";
import { FileJson, X } from "lucide-react";
import type { Language } from "../../app/language";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { parseMcpServersJson } from "./mcp-import";

const PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "API_TOKEN": "HOST_API_TOKEN" }
    },
    "remote-search": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}`;

export function McpJsonImport({
  language = "en",
  onClose,
  onImport,
}: {
  language?: Language;
  onClose: () => void;
  onImport: (servers: McpServerDefinition[]) => Promise<number>;
}) {
  const zh = language === "zh";
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    setErrors([]);
    try {
      const { servers, errors: parseErrors } = parseMcpServersJson(text);
      if (servers.length === 0) {
        setErrors(parseErrors.length ? parseErrors : [zh ? "没有可导入的 MCP Server。" : "No importable MCP servers."]);
        return;
      }
      await onImport(servers);
      if (parseErrors.length) {
        setErrors(parseErrors);
        return;
      }
      onClose();
    } catch (cause) {
      setErrors([cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mcp-modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "导入 MCP" : "Import MCP"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mcp-modal-header">
          <div className="mcp-modal-title">
            <FileJson size={15} />
            <strong>{zh ? "从 JSON 导入" : "Import from JSON"}</strong>
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
          <p className="mcp-modal-description">
            {zh
              ? "粘贴标准 mcpServers 配置，可一次导入多个服务器。env 值会作为宿主机环境变量名引用，不保存密钥。"
              : "Paste a standard mcpServers config to import one or more servers. Env values are referenced as host variable names; secrets are not stored."}
          </p>
          <textarea
            className="mcp-json-input"
            spellCheck={false}
            value={text}
            placeholder={PLACEHOLDER}
            onChange={(event) => setText(event.target.value)}
          />
          {errors.length ? (
            <div className="mcp-import-errors" role="alert">
              {errors.map((message, index) => (
                <span key={index}>{message}</span>
              ))}
            </div>
          ) : null}
        </div>
        <footer className="mcp-modal-footer">
          <button className="control-btn compact secondary" type="button" onClick={onClose} disabled={busy}>
            {zh ? "取消" : "Cancel"}
          </button>
          <button className="control-btn compact is-active" type="button" onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? (zh ? "导入中" : "Importing") : (zh ? "导入" : "Import")}
          </button>
        </footer>
      </div>
    </div>
  );
}
