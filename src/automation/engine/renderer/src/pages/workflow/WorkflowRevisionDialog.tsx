import { useState } from "react";
import { X } from "lucide-react";
import type { WorkflowV2Definition } from "../../../../shared/types";
import { validateWorkflowV2Definition } from "../../../../shared/workflow-v2/validation";

export function WorkflowRevisionDialog(props: {
  nodeId: string;
  definition: WorkflowV2Definition;
  onRevise: (nodeId: string, definition: WorkflowV2Definition, reason: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [definitionJson, setDefinitionJson] = useState(() => JSON.stringify(props.definition, null, 2));
  const [reason, setReason] = useState(() => `Human intervention at node ${props.nodeId}`);
  const [error, setError] = useState<string | undefined>();

  async function apply(): Promise<void> {
    try {
      const definition = JSON.parse(definitionJson) as WorkflowV2Definition;
      const validation = validateWorkflowV2Definition(definition);
      if (!validation.valid) throw new Error(validation.errors.join("\n"));
      if (!reason.trim()) throw new Error("Revision reason is required.");
      await props.onRevise(props.nodeId, definition, reason.trim());
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <div className="workflow-revision-backdrop" role="presentation" onClick={props.onClose}>
    <section className="workflow-revision-dialog" role="dialog" aria-modal="true" aria-label="Edit workflow and resume" onClick={(event) => event.stopPropagation()}>
      <header><div><strong>Edit workflow and resume</strong><span>A valid definition creates a new graph version and resumes the paused run.</span></div><button className="icon-btn" onClick={props.onClose} aria-label="Close revision editor"><X size={15} /></button></header>
      <label>Reason<input value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label>
      <label>Workflow definition<textarea aria-label="Workflow definition JSON" value={definitionJson} onChange={(event) => setDefinitionJson(event.currentTarget.value)} spellCheck={false} /></label>
      {error ? <div className="workflow-error">{error}</div> : null}
      <footer><button className="control-btn" onClick={props.onClose}>Cancel</button><button className="send-btn" onClick={() => void apply()}>Validate, revise &amp; resume</button></footer>
    </section>
  </div>;
}
