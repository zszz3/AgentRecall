import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { WorkflowV2Node } from "../../../../shared/workflow-v2/definition";
import { Markdown } from "../../Markdown";

function roleLabel(role?: string): string | null {
  if (role === "orchestrator") return "Orchestrator";
  if (role === "executor") return "Executor";
  if (role === "reviewer") return "Reviewer";
  return null;
}

const VALUE_TYPE_LABELS: Record<string, string> = {
  string: "String",
  number: "Number",
  boolean: "Boolean",
  json: "JSON",
  secret: "Secret",
  file: "File",
  directory: "Dir",
};

export function WorkflowNodeDrawer({
  node,
  editable,
  onClose,
  agentLabel,
  modelLabel,
}: {
  node: WorkflowV2Node;
  editable?: boolean;
  onClose: () => void;
  agentLabel?: string;
  modelLabel?: string;
}) {
  const [promptExpanded, setPromptExpanded] = useState(true);
  const role = roleLabel(node.role);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <aside className="workflow-node-drawer" role="dialog" aria-modal="false" aria-label={node.title}>
      <header className="workflow-node-drawer-header">
        <div>
          <h3>{node.title}</h3>
          {role ? <span className="workflow-node-drawer-role">{role}</span> : null}
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="workflow-node-drawer-scroll">
        {node.outputFields.length > 0 ? (
          <section className="workflow-node-drawer-section">
            <div className="workflow-node-drawer-section-head">
              <strong>Expected output</strong>
              <small>{node.outputFields.length} field{node.outputFields.length !== 1 ? "s" : ""}</small>
            </div>
            <div className="workflow-node-output-fields">
              {node.outputFields.map((field) => (
                <div key={field.key} className="workflow-node-output-field">
                  <div className="workflow-node-output-field-head">
                    <code>{field.key}</code>
                    {field.required ? <em className="required">Required</em> : null}
                    {field.valueType ? <span>{VALUE_TYPE_LABELS[field.valueType] ?? field.valueType}</span> : null}
                  </div>
                  {field.description ? <p>{field.description}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="workflow-node-drawer-empty">No expected output fields defined.</div>
        )}

        {node.execModel === "llm" && node.prompt ? (
          <section className="workflow-node-drawer-section">
            <button
              type="button"
              className="workflow-node-drawer-collapse"
              aria-expanded={promptExpanded}
              onClick={() => setPromptExpanded((v) => !v)}
            >
              {promptExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong>Prompt</strong>
              <small>{editable ? "click to view" : "collapsed"}</small>
            </button>
            {promptExpanded ? (
              <div className="workflow-node-drawer-prompt">
                <Markdown text={node.prompt} />
              </div>
            ) : null}
          </section>
        ) : null}

        {node.execModel === "script" && "script" in node ? (
          <section className="workflow-node-drawer-section">
            <div className="workflow-node-drawer-section-head">
              <strong>Script</strong>
              <small>{node.script.executable.kind === "inline" ? node.script.executable.language : "command"}</small>
            </div>
            <div className="workflow-node-output-fields">
              {node.script.parameters.map((param) => (
                <div key={param.key} className="workflow-node-output-field">
                  <div className="workflow-node-output-field-head">
                    <code>{param.key}</code>
                    {param.required ? <em className="required">Required</em> : null}
                    <span>{VALUE_TYPE_LABELS[param.valueType] ?? param.valueType}</span>
                  </div>
                  {param.description ? <p>{param.description}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <footer className="workflow-node-drawer-footer">
        {node.execModel === "llm" ? (
          <>
            <span>{node.execModel.toUpperCase()} node</span>
            {agentLabel || modelLabel ? <span>{[agentLabel, modelLabel].filter(Boolean).join(" · ")}</span> : null}
          </>
        ) : "script" in node ? (
          <>
            <span>Script node</span>
            <span>{node.script.managerRisk.level} risk</span>
          </>
        ) : null}
      </footer>
    </aside>
  );
}
