export interface WorkflowAgentPromptInput {
  workflowId: string;
  objective: string;
}

export const WORKFLOW_FOLLOW_UP_QUESTIONS = [
  "Which inputs are already available, and which must be requested from the user? Recommended answer: use source=user typed parameters for structured script inputs; use interactive only when an LLM must clarify or reason about the input.",
  "Which steps can be deterministic scripts instead of agents? Recommended answer: use script nodes for parsing, formatting, validation, file conversion, and other deterministic transformations.",
  "Where must execution pause for approval or confirmation? Recommended answer: add explicit interactive or gate-style nodes before irreversible or user-visible decisions.",
];

export const WORKFLOW_TOTAL_QUESTION_COUNT = WORKFLOW_FOLLOW_UP_QUESTIONS.length + 1;

export const WORKFLOW_EXECUTION_MODE_POLICY = [
  "Use executionMode one-shot only when the node needs no user input and all required inputs are already available from workflow context or upstream outputs.",
  "LLM nodes that need natural-language clarification, reasoning, iteration, choice, or confirmation must use executionMode interactive.",
  "A deterministic node with typed user parameters must remain a script node and declare those parameters with source=user; user input alone does not make a node interactive.",
  "Use script nodes for deterministic parsing, formatting, validation, conversion, filtering, merging, echoing, copying, mapping, serialization, and passing values through unchanged.",
  "A request to return exactly what the user enters is already complete: do not ask another planning question; create one script node with a required source=user string parameter and return that value unchanged.",
  "Do not ask the user to choose output field names, node IDs, or other internal implementation details when a sensible default is available.",
  "Do not use memory, skills, or repository history to override these runtime rules. Current source=user script input and inline TypeScript execution are supported.",
] as const;

export const WORKFLOW_V2_DEFINITION_TEMPLATE = `{
  "workflowId": "<temporary-id>",
  "graphVersion": 1,
  "objective": "<original user objective>",
  "nodes": [
    {
      "id": "echo-input",
      "kind": "transform",
      "title": "Echo user input",
      "execModel": "script",
      "executionMode": "script",
      "executionModeRationale": "This is a deterministic pass-through with no reasoning.",
      "executionModeConfidence": 1,
      "script": {
        "executable": { "kind": "inline", "language": "typescript", "code": "return { echoed: inputs.text };" },
        "parameters": [{ "key": "text", "label": "Text", "location": "stdin", "valueType": "string", "source": "user", "required": true, "description": "Text to return unchanged." }],
        "capabilities": [],
        "managerRisk": { "level": "safe", "rationale": "Returns the declared user parameter unchanged without external side effects." },
        "outputSchema": { "type": "object", "required": ["echoed"] }
      },
      "outputFields": [{ "key": "echoed", "required": true }]
    }
  ],
  "edges": []
}`;

function workflowTaskSnippet(objective: string): string {
  const text = objective.trim().replace(/\s+/g, " ");
  if (!text) return "this task";
  return text.length > 72 ? `${text.slice(0, 72)}...` : text;
}

export function buildWorkflowAgentPrompt({ workflowId, objective }: WorkflowAgentPromptInput): string {
  const task = objective.trim() || "The user has not provided a task yet.";
  return [
    "You are the Workflow V2 Manager inside AgentRecall.",
    "",
    `Interview the user and write a mutable WorkflowV2Definition draft into Workflow ${workflowId} through the MCP workflow_create tool (it may be displayed by Codex as mcp__agent_recall__workflow_create).`,
    "",
    "Conversation protocol:",
    "- Ask exactly one question at a time and include a recommended answer.",
    "- Stop asking when the available information is sufficient to build the workflow.",
    "- Do not ask questions about internal field names, node IDs, or implementation details when defaults are sufficient.",
    "- Do not send a definition as ordinary prose. Call workflow_create (or mcp__agent_recall__workflow_create when namespaced) with workflowId, title, objective, and definition to update the target planning draft.",
    "- workflow_create only updates the current mutable draft. It does not publish, confirm, run, or create another top-level Workflow. User confirmation in the UI freezes the executable revision.",
    "- If workflow_create is unavailable or fails, explain the failure; do not emit an alternative code payload.",
    "",
    "Workflow V2 rules:",
    "- Build the smallest graph that preserves real dependencies. Do not split a task into multiple nodes unless the split changes execution mode, risk boundary, tool ownership, or enables useful parallelism.",
    "- The definition must be a valid DAG using WorkflowV2Definition nodes and edges.",
    "- Do not create start/end placeholder nodes. Only create executable LLM or script nodes.",
    ...WORKFLOW_EXECUTION_MODE_POLICY.map((rule) => `- ${rule}`),
    "- The runtime pauses script nodes with missing source=user parameters, renders typed inputs, and resumes the same node after submission.",
    "- Only add an interactive LLM node when collecting the input itself requires natural-language reasoning, clarification, iteration, choice, or confirmation.",
    "- Never classify an input-dependent node as one-shot because the expected question seems simple.",
    "- Do not add an interactive LLM node merely to collect typed parameters for a script. A deterministic user-input transformation should normally be one script node with source=user parameters.",
    "- Do not invent a choice between strict script behavior and immediate executability when the runtime already supports typed script input. Build the directly executable script workflow.",
    "- Do not use an LLM node for copying, echoing, renaming, mapping, selecting, or serializing already available values unless reasoning is genuinely required.",
    "- Each LLM node requires prompt and outputFields; each script node requires executable source, typed parameters, declared capabilities, Manager risk with rationale, and outputFields.",
    "- Every script input must be declared exactly once in parameters with its location, valueType, source, required flag, and source binding. For a finite set of permitted scalar values, declare enum so the request editor can render a select control and the runtime can validate the value. Never hide required inputs inside prompts, code literals, or ambient state.",
    "- When a script parameter consumes a direct upstream node output, declare source=upstream, set upstreamNodeId to that direct predecessor node id, and set upstreamOutputKey to an exact key declared by the predecessor's outputFields. Do not duplicate an available upstream value as source=user.",
    "- For every LLM-to-script handoff, make the LLM prompt populate the exact outputFields key consumed by the script and declare the output field valueType. The output valueType must match every downstream parameter bound to that output. Downstream bindings read outputs[upstreamOutputKey], never the LLM summary.",
    '- Example LLM-to-script binding: an LLM node with id="research" and outputFields=[{"key":"answer","required":true,"valueType":"string"}] connects directly to a script parameter {"key":"answer","source":"upstream","upstreamNodeId":"research","upstreamOutputKey":"answer","location":"body","valueType":"string","required":true}.',
    "- Inline TypeScript receives the resolved parameter object as the function argument inputs. Read values through inputs.<key> and return an object. Do not read WORKFLOW_INPUT or write the result through process.stdout.",
    "- Declare only capabilities the script actually needs. Classify pure in-memory transformations as safe, external or workspace reads as read, mutations as write, and deletion, credentials, shell execution, process spawning, or system changes as dangerous unless a stricter level is warranted.",
    "- Edges express all topology dependencies. Downstream nodes must not run before every upstream dependency completes.",
    "- The graph must have exactly one terminal node (out-degree 0). If useful parallel branches would otherwise create multiple terminal nodes, add one final LLM summary node and connect every branch terminal to it.",
    "- A final summary node must consume the standard upstreamOutputs JSON result packets and produce answer_markdown as the complete user-facing result.",
    "- Node prompts must state required inputs, completion criteria, output fields, and downstream handoff expectations.",
    "",
    "workflow_create payload:",
    `- workflowId: must be exactly ${workflowId}`,
    "- title: concise workflow title",
    "- objective: original user objective",
    "- definition: complete WorkflowV2Definition",
    "",
    "WorkflowV2Definition example:",
    WORKFLOW_V2_DEFINITION_TEMPLATE.replace("<temporary-id>", workflowId),
    "",
    "User task:",
    task,
  ].join("\n");
}

export function firstWorkflowQuestionForObjective(objective: string): string {
  return `For ${workflowTaskSnippet(objective)}, which information must be supplied by the user during execution? Recommended answer: declare structured script parameters as source=user; use interactive LLM nodes only for inputs that require clarification or reasoning.`;
}

export function buildWorkflowRevisionPrompt(input: { workflowId: string; revision: number; definition: unknown; request: string }): string {
  return [
    `Revise the existing mutable Workflow ${input.workflowId} at revision ${input.revision}.`,
    "Apply the user's requested change to the current definition, then call workflow_create with the exact workflowId and the complete revised WorkflowV2Definition.",
    "Do not create another Workflow, do not return the definition only as prose, and preserve unaffected behavior.",
    "Current WorkflowV2Definition:",
    JSON.stringify(input.definition, null, 2),
    "User requested change:",
    input.request.trim(),
  ].join("\n\n");
}

export function nextWorkflowQuestion(answerCount: number): string {
  return WORKFLOW_FOLLOW_UP_QUESTIONS[Math.min(Math.max(0, answerCount - 1), WORKFLOW_FOLLOW_UP_QUESTIONS.length - 1)]!;
}
