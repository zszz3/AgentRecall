import { memo, type ReactElement } from "react";
import { splitWorkflowV2WorkerOutputContent, workflowV2UserFacingOutput } from "../../../../shared/workflow-v2/packets";
import { Markdown } from "../../Markdown";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function structuredJson(content: string): JsonValue[] | { [key: string]: JsonValue } | undefined {
  const trimmed = content.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return Array.isArray(parsed) || (parsed !== null && typeof parsed === "object") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function trailingStructuredJson(content: string): { text: string; value: JsonValue[] | { [key: string]: JsonValue } } | undefined {
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "{" && character !== "[") continue;
    const value = structuredJson(content.slice(index));
    if (value !== undefined) return { text: content.slice(0, index).trimEnd(), value };
  }
  return undefined;
}

function JsonNode({ value }: { value: JsonValue }): ReactElement {
  if (Array.isArray(value)) {
    return <ol className="workflow-node-json-array">
      {value.map((item, index) => <li key={index}><JsonNode value={item} /></li>)}
    </ol>;
  }
  if (value !== null && typeof value === "object") {
    return <dl className="workflow-node-json-object">
      {Object.entries(value).map(([key, item]) => <div key={key} className="workflow-node-json-entry">
        <dt>{key}</dt><dd><JsonNode value={item} /></dd>
      </div>)}
    </dl>;
  }
  if (value === null) return <span className="workflow-node-json-null">null</span>;
  if (typeof value === "string") return <span>{value}</span>;
  return <span className="workflow-node-json-literal">{String(value)}</span>;
}

export const WorkflowMessageContent = memo(function WorkflowMessageContent({ content }: { content: string }) {
  const packetContent = splitWorkflowV2WorkerOutputContent(content);
  if (packetContent) {
    return <div className="workflow-node-message-segments">
      {packetContent.leadingText ? <p>{packetContent.leadingText}</p> : null}
      <div className="workflow-node-user-output"><Markdown text={workflowV2UserFacingOutput(packetContent.value)} /></div>
    </div>;
  }
  const value = structuredJson(content);
  if (value !== undefined) return <div className="workflow-node-json"><JsonNode value={value} /></div>;
  const trailing = trailingStructuredJson(content);
  if (!trailing) return <p>{content}</p>;
  return <div className="workflow-node-message-segments">
    {trailing.text ? <p>{trailing.text}</p> : null}
    <div className="workflow-node-json"><JsonNode value={trailing.value} /></div>
  </div>;
});
