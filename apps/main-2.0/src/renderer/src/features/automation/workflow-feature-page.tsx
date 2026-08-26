import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Activity, ArrowLeft, Bot, Braces, CirclePause, Code2, Copy, File, FolderOpen, GitBranch, Hash, LayoutTemplate, List, Pause, Pencil, Play, Plus, RotateCcw, Save, Settings2, ShieldCheck, Square, ToggleLeft, Trash2, Type as TypeIcon, UserRound, X } from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowInputDefinition,
  WorkflowNode,
  WorkflowNodeInput,
  WorkflowOutputField,
  WorkflowRun,
  WorkflowNodeRunStatus,
  WorkflowScriptPermission,
  WorkflowValueType,
} from "../../../../automation/engine/shared/workflow/model";
import { workflowNodeInputKey } from "../../../../automation/engine/shared/workflow/model";
import { validateWorkflowDefinition } from "../../../../automation/engine/shared/workflow/validation";
import { agentRecallAutomationService } from "../../../../automation/engine/renderer/src/app/services/agent-recall-service";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { useAutomationStoreSnapshot } from "./automation-provider";
import { addWorkflowNode, createWorkflowCopy, createWorkflowDefinition, type WorkflowNodeKind } from "./workflow-editor-model";
import { WorkflowGraphCanvas } from "./workflow-graph-canvas";
import { reduceWorkflowRunStream, workflowRunStreamKey, type WorkflowRunStreamState } from "./workflow-run-stream";

type EditorMode = "definition" | "run";

export type WorkflowInitialRequest =
  | { workflowId: string }
  | { createNew: true };

const valueTypes: WorkflowValueType[] = ["text", "number", "boolean", "file", "object", "list"];
const scriptPermissions: WorkflowScriptPermission[] = ["workspace_read", "workspace_write", "workspace_delete", "network", "process"];
const nodeKinds: Array<{ kind: WorkflowNodeKind; label: string; icon: typeof Bot }> = [
  { kind: "agent", label: "Agent", icon: Bot },
  { kind: "script", label: "Script", icon: Code2 },
  { kind: "review", label: "Review", icon: ShieldCheck },
  { kind: "approval", label: "Approval", icon: CirclePause },
];

function parseInputValue(type: WorkflowValueType, raw: string): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "object" || type === "list") return JSON.parse(raw) as unknown;
  return raw;
}

function blankOutput(index: number): WorkflowOutputField {
  return { key: `output${index}`, name: `Output ${index}`, description: "Describe this output", type: "text", required: true };
}

const runStatusLabel: Record<WorkflowRun["status"], string> = {
  running: "运行中",
  paused: "已暂停",
  waiting: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const nodeRunStatusLabel: Record<WorkflowNodeRunStatus, string> = {
  pending: "待运行",
  ready: "就绪",
  running: "运行中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const runEventLabel: Record<WorkflowRun["events"][number]["type"], string> = {
  run_started: "开始运行",
  run_paused: "暂停运行",
  run_resumed: "继续运行",
  run_completed: "运行完成",
  run_failed: "运行失败",
  run_cancelled: "取消运行",
  node_started: "节点开始",
  node_waiting: "等待确认",
  node_completed: "节点完成",
  node_failed: "节点失败",
  node_retried: "重试节点",
  approval_resolved: "确认完成",
  review_revised: "进入修订",
};

function formatRunDuration(run: WorkflowRun): string {
  const seconds = Math.max(0, Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function RunStatusBar({ run }: { run: WorkflowRun }): ReactElement {
  const completed = Object.values(run.nodeRuns).filter((state) => state.status === "completed").length;
  const total = run.definition.nodes.length;
  const activeNodes = run.definition.nodes.filter((node) => {
    const status = run.nodeRuns[node.id]?.status;
    return status === "running" || status === "waiting";
  });
  const latestEvent = run.events.at(-1);
  const latestNode = latestEvent?.nodeId ? run.definition.nodes.find((node) => node.id === latestEvent.nodeId) : undefined;
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  return <div className={`workflow-core-run-statusbar is-${run.status}`}>
    <span className="workflow-core-run-pulse"><Activity size={13} /></span>
    <strong>{runStatusLabel[run.status]}</strong>
    <span className="workflow-core-run-current">{activeNodes.length > 0 ? activeNodes.map((node) => node.title).join(" · ") : latestEvent ? `${runEventLabel[latestEvent.type]}${latestNode ? ` · ${latestNode.title}` : ""}` : "准备运行"}</span>
    <span className="workflow-core-run-progress"><i><b style={{ width: `${progress}%` }} /></i><em>{completed}/{total}</em></span>
    <time>{formatRunDuration(run)}</time>
  </div>;
}

function updateAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

function FieldText({ label, value, onChange, multiline = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}): ReactElement {
  return <label className="workflow-core-field"><span>{label}</span>{multiline
    ? <textarea value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    : <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />}</label>;
}

function OutputFieldForm({ field, onChange }: {
  field: WorkflowOutputField;
  onChange: (field: WorkflowOutputField) => void;
}): ReactElement {
  return <div className="workflow-core-input-form"><div className="workflow-core-field-pair"><FieldText label="Key" value={field.key} onChange={(key) => onChange({ ...field, key })} /><FieldText label="Name" value={field.name} onChange={(name) => onChange({ ...field, name })} /></div><FieldText label="Description" value={field.description} onChange={(description) => onChange({ ...field, description })} /><label className="workflow-core-field"><span>Type</span><select value={field.type} onChange={(event) => onChange({ ...field, type: event.currentTarget.value as WorkflowValueType })}>{valueTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label className="workflow-core-required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => onChange({ ...field, required: event.currentTarget.checked })} /><span><strong>Required output</strong><small>The node must return this field.</small></span></label></div>;
}

function OutputFieldRow({ field, onEdit }: { field: WorkflowOutputField; onEdit: () => void }): ReactElement {
  const Icon = field.type === "boolean" ? ToggleLeft : field.type === "number" ? Hash : field.type === "list" ? List : field.type === "object" ? Braces : field.type === "file" ? File : TypeIcon;
  return <button type="button" className="workflow-core-input-row workflow-core-output-row" onClick={onEdit}><span className={`workflow-core-type-mark is-${field.type}`}><Icon size={13} /></span><span className="workflow-core-input-row-main"><span><strong>{field.name}</strong><code>{field.key}</code></span><small>{field.description}</small><em>{field.type}</em></span>{field.required ? <span className="workflow-core-required-dot" title="Required" /> : null}<Pencil className="workflow-core-input-edit" size={12} /></button>;
}

function inputSourcePresentation(input: WorkflowNodeInput, nodes: WorkflowNode[], workflowInputs: WorkflowInputDefinition[], language: LanguageMode): { label: string; title: string; description: string; detail: string } {
  if (input.source === "workflow") {
    const field = workflowInputs.find((item) => item.key === input.workflowInputKey);
    return {
      label: localize(language, "Workflow", "工作流"),
      title: field?.name ?? input.workflowInputKey,
      description: field?.description ?? "",
      detail: localize(language, "Run input", "运行输入"),
    };
  }
  const node = nodes.find((item) => item.id === input.nodeId);
  const field = node?.outputs.find((item) => item.key === input.outputKey);
  return {
    label: localize(language, "Upstream", "上游"),
    title: field?.name ?? input.outputKey,
    description: field?.description ?? "",
    detail: node?.title ?? localize(language, "Unknown node", "未知节点"),
  };
}

function NodeInputRow({ input, nodes, workflowInputs, language, onRemove }: {
  input: WorkflowNodeInput;
  nodes: WorkflowNode[];
  workflowInputs: WorkflowInputDefinition[];
  language: LanguageMode;
  onRemove: () => void;
}): ReactElement {
  const source = inputSourcePresentation(input, nodes, workflowInputs, language);
  const Icon = input.source === "workflow" ? Braces : GitBranch;
  return <div className="workflow-core-input-row workflow-core-reference-row"><span className={`workflow-core-source-mark is-${input.source}`} title={source.label}><Icon size={13} /></span><span className="workflow-core-input-row-main"><span><strong>{source.title}</strong><em>{source.label}</em></span><small>{source.description}</small><em>{source.detail}</em></span><button type="button" className="workflow-core-reference-remove" aria-label={localize(language, "Remove input", "移除输入")} onClick={onRemove}><X size={12} /></button></div>;
}

function WorkflowInputRow({ input, onEdit }: { input: WorkflowInputDefinition; onEdit: () => void }): ReactElement {
  const Icon = input.type === "boolean" ? ToggleLeft : input.type === "number" ? Hash : input.type === "list" ? List : input.type === "object" ? Braces : input.type === "file" ? File : TypeIcon;
  return <button type="button" className="workflow-core-input-row" onClick={onEdit}><span className={`workflow-core-type-mark is-${input.type}`}><Icon size={13} /></span><span className="workflow-core-input-row-main"><span><strong>{input.name}</strong><code>{input.key}</code></span><small>{input.description}</small><em>{input.type}</em></span>{input.required ? <span className="workflow-core-required-dot" title="Required" /> : null}<Pencil className="workflow-core-input-edit" size={12} /></button>;
}

function WorkflowInputForm({ input, onChange }: { input: WorkflowInputDefinition; onChange: (input: WorkflowInputDefinition) => void }): ReactElement {
  return <div className="workflow-core-input-form"><div className="workflow-core-field-pair"><FieldText label="Key" value={input.key} onChange={(key) => onChange({ ...input, key })} /><FieldText label="Name" value={input.name} onChange={(name) => onChange({ ...input, name })} /></div><FieldText label="Description" value={input.description} onChange={(description) => onChange({ ...input, description })} /><label className="workflow-core-field"><span>Type</span><select value={input.type} onChange={(event) => onChange({ ...input, type: event.currentTarget.value as WorkflowValueType })}>{valueTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label className="workflow-core-required-toggle"><input type="checkbox" checked={input.required} onChange={(event) => onChange({ ...input, required: event.currentTarget.checked })} /><span><strong>Required input</strong><small>The Workflow cannot start without this value.</small></span></label></div>;
}

function NodeInspector({ definition, node, agentIds, language, onChange, onDelete }: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  agentIds: Array<{ id: string; name: string }>;
  language: LanguageMode;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
}): ReactElement {
  const [tab, setTab] = useState<"general" | "inputs" | "outputs">("general");
  const [editingOutputIndex, setEditingOutputIndex] = useState<number>();
  const changeInputs = (inputs: WorkflowNodeInput[]): void => onChange({ ...node, inputs } as WorkflowNode);
  const changeOutputs = (outputs: WorkflowOutputField[]): void => onChange({ ...node, outputs } as WorkflowNode);
  const editingOutput = editingOutputIndex === undefined ? undefined : node.outputs[editingOutputIndex];
  const addInputReference = (value: string): void => {
    if (!value) return;
    const [source, first, second] = value.split("|");
    if (source === "workflow" && first) changeInputs([...node.inputs, { source, workflowInputKey: first }]);
    if (source === "node" && first && second) changeInputs([...node.inputs, { source, nodeId: first, outputKey: second }]);
  };
  const hasWorkflowInput = (key: string): boolean => node.inputs.some((input) => input.source === "workflow" && input.workflowInputKey === key);
  const hasNodeOutput = (nodeId: string, outputKey: string): boolean => node.inputs.some((input) => input.source === "node" && input.nodeId === nodeId && input.outputKey === outputKey);
  const upstreamOptions = definition.nodes.filter((item) => item.id !== node.id).flatMap((item) => item.outputs.map((output) => ({ node: item, output })).filter(({ output }) => !hasNodeOutput(item.id, output.key)));
  return <div className="workflow-core-inspector-content">
    <div className="workflow-core-inspector-title"><span>{node.kind}</span><button type="button" className="icon-btn" onClick={onDelete} aria-label="Delete node"><Trash2 size={14} /></button></div>
    <nav className="workflow-core-inspector-tabs"><button type="button" className={tab === "general" ? "is-active" : ""} onClick={() => setTab("general")}>{localize(language, "Basic", "基础")}</button><button type="button" className={tab === "inputs" ? "is-active" : ""} onClick={() => setTab("inputs")}>{localize(language, "Inputs", "输入")} <span>{node.inputs.length}</span></button><button type="button" className={tab === "outputs" ? "is-active" : ""} onClick={() => setTab("outputs")}>{localize(language, "Outputs", "输出")} <span>{node.outputs.length}</span></button></nav>
    {tab === "general" ? <div className="workflow-core-tab-panel">
      <FieldText label="Name" value={node.title} onChange={(title) => onChange({ ...node, title } as WorkflowNode)} />
      <FieldText label="Goal" multiline value={node.goal} onChange={(goal) => onChange({ ...node, goal } as WorkflowNode)} />
      {(node.kind === "agent" || node.kind === "review") ? <label className="workflow-core-field"><span>Agent</span><select value={node.agentId} onChange={(event) => onChange({ ...node, agentId: event.currentTarget.value })}>{agentIds.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label> : null}
      {(node.kind === "agent" || node.kind === "review") ? <><FieldText label="Instructions (one per line)" multiline value={node.instructions.join("\n")} onChange={(value) => onChange({ ...node, instructions: value.split("\n").filter(Boolean) })} /><FieldText label="Constraints (one per line)" multiline value={node.constraints.join("\n")} onChange={(value) => onChange({ ...node, constraints: value.split("\n").filter(Boolean) })} /></> : null}
      {node.kind === "script" ? <><label className="workflow-core-field"><span>Runtime</span><select value={node.runtime} onChange={(event) => onChange({ ...node, runtime: event.currentTarget.value as typeof node.runtime })}><option value="bash">Bash</option><option value="python">Python</option><option value="typescript">TypeScript</option></select></label><FieldText label="Source" multiline value={node.source} onChange={(source) => onChange({ ...node, source })} /><label className="workflow-core-field"><span>Timeout (seconds)</span><input type="number" min="1" value={node.timeoutSeconds} onChange={(event) => onChange({ ...node, timeoutSeconds: Number(event.currentTarget.value) })} /></label><div className="workflow-core-field"><span>Permissions</span><div className="workflow-core-permissions">{scriptPermissions.map((permission) => <label className="workflow-core-check" key={permission}><input type="checkbox" checked={node.permissions.includes(permission)} onChange={(event) => onChange({ ...node, permissions: event.currentTarget.checked ? [...node.permissions, permission] : node.permissions.filter((item) => item !== permission) })} /> {permission.replaceAll("_", " ")}</label>)}</div></div></> : null}
      {node.kind === "review" ? <><FieldText label="Review criteria (one per line)" multiline value={node.criteria.map((item) => item.description).join("\n")} onChange={(value) => onChange({ ...node, criteria: value.split("\n").filter(Boolean).map((description, index) => ({ key: `criterion${index + 1}`, description })) })} /><label className="workflow-core-field"><span>Revision attempts</span><input type="number" min="0" value={node.maxRevisions} onChange={(event) => onChange({ ...node, maxRevisions: Number(event.currentTarget.value) })} /></label></> : null}
      {node.kind === "approval" ? <FieldText label="Decision message" multiline value={node.message} onChange={(message) => onChange({ ...node, message })} /> : null}
      <FieldText label="Completion criteria (one per line)" multiline value={node.acceptanceCriteria.join("\n")} onChange={(value) => onChange({ ...node, acceptanceCriteria: value.split("\n").filter(Boolean) } as WorkflowNode)} />
    </div> : null}
    {tab === "inputs" ? <section className="workflow-core-tab-panel workflow-core-schema-section"><header><div><strong>{localize(language, "Inputs", "输入")}</strong><span>{localize(language, "Reference Workflow data or an upstream result", "直接引用工作流数据或上游结果")}</span></div><select className="workflow-core-reference-picker" aria-label={localize(language, "Add input reference", "添加输入引用")} value="" onChange={(event) => addInputReference(event.currentTarget.value)}><option value="">{localize(language, "+ Reference data", "+ 引用数据")}</option>{definition.inputs.some((input) => !hasWorkflowInput(input.key)) ? <optgroup label={localize(language, "Workflow inputs", "工作流输入")}>{definition.inputs.filter((input) => !hasWorkflowInput(input.key)).map((input) => <option key={input.key} value={`workflow|${input.key}`}>{input.name}</option>)}</optgroup> : null}{upstreamOptions.length > 0 ? <optgroup label={localize(language, "Upstream outputs", "上游输出")}>{upstreamOptions.map(({ node: sourceNode, output }) => <option key={`${sourceNode.id}:${output.key}`} value={`node|${sourceNode.id}|${output.key}`}>{sourceNode.title} · {output.name}</option>)}</optgroup> : null}</select></header>{node.inputs.length === 0 ? <p className="workflow-core-muted">{localize(language, "This node uses the shared workspace. Reference extra data only when needed.", "此节点已自动使用公共工作目录，仅在需要时引用额外数据。")}</p> : <div className="workflow-core-input-list">{node.inputs.map((input, index) => <NodeInputRow key={input.source === "workflow" ? `workflow:${input.workflowInputKey}` : `node:${input.nodeId}:${input.outputKey}`} input={input} nodes={definition.nodes} workflowInputs={definition.inputs} language={language} onRemove={() => changeInputs(node.inputs.filter((_, itemIndex) => itemIndex !== index))} />)}</div>}</section> : null}
    {tab === "outputs" ? editingOutput ? <section className="workflow-core-tab-panel"><header className="workflow-core-detail-head"><button type="button" onClick={() => setEditingOutputIndex(undefined)}><ArrowLeft size={13} /> {localize(language, "Outputs", "输出")}</button><button type="button" className="workflow-core-delete-field" onClick={() => { changeOutputs(node.outputs.filter((_, itemIndex) => itemIndex !== editingOutputIndex)); setEditingOutputIndex(undefined); }}><Trash2 size={12} /> {localize(language, "Delete", "删除")}</button></header><OutputFieldForm field={editingOutput} onChange={(next) => changeOutputs(updateAt(node.outputs, editingOutputIndex!, next))} /></section> : <section className="workflow-core-tab-panel workflow-core-schema-section"><header><div><strong>{localize(language, "Outputs", "输出")}</strong><span>{localize(language, "Validated data produced by this node", "此节点生成并校验的数据")}</span></div><button type="button" className="control-btn compact" onClick={() => { changeOutputs([...node.outputs, blankOutput(node.outputs.length + 1)]); setEditingOutputIndex(node.outputs.length); }}><Plus size={12} /> {localize(language, "Add", "添加")}</button></header><div className="workflow-core-input-list">{node.outputs.map((output, index) => <OutputFieldRow key={`${output.key}:${index}`} field={output} onEdit={() => setEditingOutputIndex(index)} />)}</div></section> : null}
  </div>;
}

function DefinitionInspector({ definition, runInputs, defaultWorkDir, isNewDraft, language, onChange, onPickWorkDir, onClearWorkDir, onRunInputChange }: {
  definition: WorkflowDefinition;
  runInputs: Record<string, string>;
  defaultWorkDir: string;
  isNewDraft: boolean;
  language: LanguageMode;
  onChange: (definition: WorkflowDefinition) => void;
  onPickWorkDir: () => void;
  onClearWorkDir: () => void;
  onRunInputChange: (key: string, value: string) => void;
}): ReactElement {
  const [tab, setTab] = useState<"setup" | "inputs" | "run">("setup");
  const [editingInputIndex, setEditingInputIndex] = useState<number>();
  const editingInput = editingInputIndex === undefined ? undefined : definition.inputs[editingInputIndex];
  const workDir = definition.workDir || defaultWorkDir;
  const workspaceActions = <div className="workflow-core-workspace-actions"><button type="button" className="control-btn compact" onClick={onPickWorkDir}><FolderOpen size={12} /> {localize(language, isNewDraft ? "Set global default" : "Choose directory", isNewDraft ? "设置全局默认" : "选择目录")}</button>{!isNewDraft && definition.workDir ? <button type="button" className="icon-btn" aria-label={localize(language, "Clear Workflow directory", "清除 Workflow 目录")} title={localize(language, "Use global default", "使用全局默认")} onClick={onClearWorkDir}><X size={13} /></button> : null}</div>;
  return <div className="workflow-core-inspector-content">
    <div className="workflow-core-inspector-title"><span>Workflow definition</span>{workspaceActions}</div>
    <nav className="workflow-core-inspector-tabs"><button type="button" className={tab === "setup" ? "is-active" : ""} onClick={() => setTab("setup")}>Basic</button><button type="button" className={tab === "inputs" ? "is-active" : ""} onClick={() => setTab("inputs")}>Inputs <span>{definition.inputs.length}</span></button><button type="button" className={tab === "run" ? "is-active" : ""} onClick={() => setTab("run")}>Run</button></nav>
    {tab === "setup" ? <div className="workflow-core-tab-panel"><div className="workflow-core-workspace-summary"><FolderOpen size={15} /><span><strong>{definition.workDir ? localize(language, "Workflow workspace", "Workflow 工作目录") : localize(language, "Shared workspace", "公共工作目录")}</strong><small title={workDir}>{workDir || localize(language, "Current workspace", "当前工作目录")}</small></span><em>{definition.workDir ? localize(language, "Workflow-specific", "Workflow 专属") : localize(language, "Global default", "全局默认")}</em></div><FieldText label="Name" value={definition.name} onChange={(name) => onChange({ ...definition, name })} /><FieldText label="Description" multiline value={definition.description} onChange={(description) => onChange({ ...definition, description })} /></div> : null}
    {tab === "inputs" ? editingInput ? <section className="workflow-core-tab-panel"><header className="workflow-core-detail-head"><button type="button" onClick={() => setEditingInputIndex(undefined)}><ArrowLeft size={13} /> Workflow inputs</button><button type="button" className="workflow-core-delete-field" onClick={() => { onChange({ ...definition, inputs: definition.inputs.filter((_, itemIndex) => itemIndex !== editingInputIndex) }); setEditingInputIndex(undefined); }}><Trash2 size={12} /> Delete</button></header><WorkflowInputForm input={editingInput} onChange={(next) => onChange({ ...definition, inputs: updateAt(definition.inputs, editingInputIndex!, next) })} /></section> : <section className="workflow-core-tab-panel workflow-core-schema-section"><header><div><strong>Workflow inputs</strong><span>Values supplied when a run starts</span></div><button type="button" className="control-btn compact" onClick={() => { onChange({ ...definition, inputs: [...definition.inputs, { key: `input${definition.inputs.length + 1}`, name: `Input ${definition.inputs.length + 1}`, description: "Describe this input", type: "text", required: true }] }); setEditingInputIndex(definition.inputs.length); }}><Plus size={12} /> Add</button></header><div className="workflow-core-input-list">{definition.inputs.map((input, index) => <WorkflowInputRow key={`${input.key}:${index}`} input={input} onEdit={() => setEditingInputIndex(index)} />)}</div></section> : null}
    {tab === "run" ? <section className="workflow-core-tab-panel workflow-core-schema-section workflow-core-run-values"><header><strong>Run values</strong><span>Used for the next run</span></header>{definition.inputs.length === 0 ? <p className="workflow-core-muted">This Workflow has no external inputs.</p> : definition.inputs.map((input) => <label className="workflow-core-field" key={input.key}><span>{input.name}<small>{input.description}</small></span>{input.type === "boolean" ? <select value={runInputs[input.key] ?? "false"} onChange={(event) => onRunInputChange(input.key, event.currentTarget.value)}><option value="false">false</option><option value="true">true</option></select> : <input value={runInputs[input.key] ?? ""} placeholder={input.type === "object" || input.type === "list" ? "JSON value" : input.type} onChange={(event) => onRunInputChange(input.key, event.currentTarget.value)} />}</label>)}</section> : null}
  </div>;
}

function RunDataValue({ value }: { value: unknown }): ReactElement {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="workflow-core-run-scalar is-empty">暂无内容</span>;
    return <ol className="workflow-core-run-list">{value.map((item, index) => <li key={index}><RunDataValue value={item} /></li>)}</ol>;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="workflow-core-run-scalar is-empty">暂无内容</span>;
    return <dl className="workflow-core-run-properties">{entries.map(([key, item]) => <div key={key}><dt>{key}</dt><dd><RunDataValue value={item} /></dd></div>)}</dl>;
  }
  if (typeof value === "string") {
    const paragraphs = value.split(/\n\s*\n/u);
    if (paragraphs.length === 1) return <span className={`workflow-core-run-scalar${value ? "" : " is-empty"}`}>{value || "—"}</span>;
    return <div className="workflow-core-run-text">{paragraphs.map((paragraph, index) => <p className="workflow-core-run-paragraph" key={index}>{paragraph}</p>)}</div>;
  }
  return <span className={`workflow-core-run-scalar${value === null || value === undefined ? " is-empty" : ""}`}>{value === null || value === undefined ? "—" : String(value)}</span>;
}

function RunDataField({ fieldKey, label, value }: { fieldKey: string; label: string; value: unknown }): ReactElement {
  return <article className="workflow-core-run-field" data-field-key={fieldKey}>
    <header><strong>{label}</strong>{label === fieldKey ? null : <code>{fieldKey}</code>}</header>
    <div className="workflow-core-run-value"><RunDataValue value={value} /></div>
  </article>;
}

function RunInspector({ run, selectedNodeId, liveOutput, onRetry, onApprove }: {
  run?: WorkflowRun;
  selectedNodeId?: string;
  liveOutput?: string;
  onRetry: (nodeId: string) => void;
  onApprove: (nodeId: string, decision: string) => void;
}): ReactElement {
  if (!run) return <div className="workflow-core-empty">Run this Workflow to inspect node inputs, outputs, errors, and approvals.</div>;
  const node = run.definition.nodes.find((item) => item.id === selectedNodeId);
  const state = node ? run.nodeRuns[node.id] : undefined;
  if (!node || !state) return <div className="workflow-core-empty">Select a node.</div>;
  const nodeEvents = run.events.filter((event) => event.nodeId === node.id).slice(-8).reverse();
  const inputEntries = Object.entries(state.resolvedInputs ?? {});
  const outputEntries = Object.entries(state.outputs ?? {});
  const inputLabels = new Map(node.inputs.map((input) => {
    const key = workflowNodeInputKey(input);
    const field = input.source === "workflow"
      ? run.definition.inputs.find((candidate) => candidate.key === input.workflowInputKey)
      : run.definition.nodes.find((candidate) => candidate.id === input.nodeId)?.outputs.find((candidate) => candidate.key === input.outputKey);
    return [key, field?.name ?? key];
  }));
  const outputLabels = new Map(node.outputs.map((output) => [output.key, output.name]));
  const elapsedSeconds = Math.max(0, Math.floor(((state.finishedAt ?? Date.now()) - (state.startedAt ?? run.startedAt)) / 1000));
  const showLiveOutput = (node.kind === "agent" || node.kind === "review")
    && (state.status === "running" || liveOutput !== undefined);
  return <div className="workflow-core-inspector-content is-run">
    <div className="workflow-core-run-head"><span><strong>{node.title}</strong><small>第 {state.attempt} 次执行 · {elapsedSeconds}s</small></span><em className={`workflow-core-run-head-status is-${state.status}`}><i />{nodeRunStatusLabel[state.status]}</em></div>
    {showLiveOutput ? <section className="workflow-core-live-output" aria-live="polite" aria-busy={state.status === "running"}><header><strong>实时输出</strong>{state.status === "running" ? null : <span><i />已记录</span>}</header><pre className={liveOutput ? undefined : "is-waiting"}>{liveOutput || "正在等待 Agent 输出…"}</pre></section> : null}
    {state.error ? <div className="workflow-core-error"><strong>{state.error.code}</strong><p>{state.error.message}</p>{state.error.fieldPath ? <code>{state.error.fieldPath}</code> : null}</div> : null}
    {state.status === "failed" ? <button type="button" className="control-btn" onClick={() => onRetry(node.id)}><RotateCcw size={14} /> Retry this node</button> : null}
    {node.kind === "approval" && state.status === "waiting" ? <section className="workflow-core-approval"><p>{node.message}</p>{node.options.map((option) => <button type="button" className="control-btn" key={option.value} onClick={() => onApprove(node.id, option.value)}>{option.label}<small>{option.description}</small></button>)}</section> : null}
    <details className="workflow-core-run-disclosure"><summary><span>输入</span><em>{inputEntries.length > 0 ? `${inputEntries.length} 项` : "暂无"}</em></summary><div className="workflow-core-run-disclosure-content">{inputEntries.length > 0 ? <section className="workflow-core-run-data">{inputEntries.map(([key, value]) => <RunDataField key={key} fieldKey={key} label={inputLabels.get(key) ?? key} value={value} />)}</section> : <p className="workflow-core-muted">此节点没有解析后的输入。</p>}</div></details>
    <details className="workflow-core-run-disclosure"><summary><span>输出</span><em>{outputEntries.length > 0 ? `${outputEntries.length} 项` : state.status === "running" ? "等待生成" : "暂无"}</em></summary><div className="workflow-core-run-disclosure-content">{outputEntries.length > 0 ? <section className="workflow-core-run-data">{outputEntries.map(([key, value]) => <RunDataField key={key} fieldKey={key} label={outputLabels.get(key) ?? key} value={value} />)}</section> : <p className="workflow-core-muted">此节点尚未生成已校验的输出。</p>}</div></details>
    <details className="workflow-core-run-disclosure"><summary><span>运行记录</span><em>{nodeEvents.length} 条</em></summary><div className="workflow-core-run-disclosure-content">{nodeEvents.length > 0 ? <section className="workflow-core-run-events">{nodeEvents.map((event) => <div key={event.sequence}><i className={`is-${event.type}`} /><span><strong>{runEventLabel[event.type]}</strong><small>{event.durationMs === undefined ? `第 ${event.attempt ?? state.attempt} 次` : `${event.durationMs} ms`}</small></span><time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>)}</section> : <p className="workflow-core-muted">暂无运行记录。</p>}</div></details>
  </div>;
}

export function WorkflowFeaturePage({
  language,
  initialRequest,
  onInitialRequestConsumed,
}: {
  language: LanguageMode;
  globalReviewEnabled: boolean;
  runtimeReviewEnabled: boolean;
  initialRequest?: WorkflowInitialRequest;
  onInitialRequestConsumed?: () => void;
}): ReactElement {
  const api = useMemo(() => agentRecallAutomationService(), []);
  const automation = useAutomationStoreSnapshot();
  const agents = automation.configuredAgents.map((agent) => ({ id: agent.id, name: agent.name }));
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<WorkflowDefinition>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [definitionInspectorOpen, setDefinitionInspectorOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode>("definition");
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [runStreams, setRunStreams] = useState<WorkflowRunStreamState>({});
  const [personalMenu, setPersonalMenu] = useState<{ definitionId: string; x: number; y: number; hasActiveRun?: boolean }>();
  const [newDraftIds, setNewDraftIds] = useState<Set<string>>(() => new Set());
  const [globalWorkDir, setGlobalWorkDir] = useState(automation.workDir);

  useEffect(() => setGlobalWorkDir(automation.workDir), [automation.workDir]);

  const load = useCallback(async (preferId?: string) => {
    const snapshot = await api.getWorkflowCore(preferId);
    setDefinitions(snapshot.definitions);
    setRuns(snapshot.runs);
    const preferredId = preferId && snapshot.definitions.some((item) => item.id === preferId)
      ? preferId
      : undefined;
    const nextId = preferredId
      ?? (snapshot.definitions.some((item) => item.id === selectedId) ? selectedId : undefined)
      ?? snapshot.definitions.find((item) => !item.isTemplate)?.id
      ?? snapshot.definitions[0]?.id;
    setSelectedId(nextId);
    const next = snapshot.definitions.find((item) => item.id === nextId);
    if (next) setDraft(structuredClone(next));
  }, [api, selectedId]);

  const createNewWorkflow = (): void => {
    const next = createWorkflowDefinition(agents[0]?.id ?? "");
    setNewDraftIds((current) => new Set(current).add(next.id));
    setDefinitions((current) => [next, ...current]);
    setDraft(next);
    setSelectedId(next.id);
    setSelectedNodeId(undefined);
    setDefinitionInspectorOpen(false);
    setMode("definition");
  };

  useEffect(() => {
    void (async () => {
      try {
        await load(initialRequest && "workflowId" in initialRequest ? initialRequest.workflowId : undefined);
        if (initialRequest && "createNew" in initialRequest) createNewWorkflow();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (initialRequest) onInitialRequestConsumed?.();
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => api.onWorkflowRunStream((event) => {
    setRunStreams((current) => reduceWorkflowRunStream(current, event));
  }), [api]);
  useEffect(() => {
    if (!personalMenu) return undefined;
    const close = (): void => setPersonalMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [personalMenu]);
  const activeRun = runs.filter((run) => run.workflowId === selectedId).sort((left, right) => right.startedAt - left.startedAt)[0];
  useEffect(() => {
    if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "waiting")) return;
    const timer = window.setInterval(() => void load(selectedId).catch(() => undefined), 1200);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status, load, selectedId]);
  useEffect(() => {
    if (mode !== "run" || selectedNodeId || !activeRun) return;
    const activeNode = activeRun.definition.nodes.find((node) => {
      const status = activeRun.nodeRuns[node.id]?.status;
      return status === "running" || status === "waiting" || status === "failed";
    });
    if (activeNode) setSelectedNodeId(activeNode.id);
  }, [activeRun, mode, selectedNodeId]);

  const issues = draft ? validateWorkflowDefinition(draft, new Set(agents.map((agent) => agent.id))) : [];
  const templates = definitions.filter((definition) => definition.isTemplate);
  const personalDefinitions = definitions.filter((definition) => !definition.isTemplate);
  const isTemplate = draft?.isTemplate === true;
  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId);
  const selectDefinition = (definition: WorkflowDefinition): void => {
    setSelectedId(definition.id); setDraft(structuredClone(definition)); setSelectedNodeId(undefined); setDefinitionInspectorOpen(false); setMode("definition"); setError(undefined);
    void load(definition.id).catch(() => undefined);
  };
  const useTemplate = async (): Promise<void> => {
    if (!draft?.isTemplate) return;
    setBusy(true); setError(undefined);
    try {
      const saved = await api.saveWorkflowDefinition(createWorkflowCopy(draft));
      await load(saved.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const save = async (): Promise<WorkflowDefinition | undefined> => {
    if (!draft || draft.isTemplate) return undefined;
    setBusy(true); setError(undefined);
    try {
      const next = { ...draft, updatedAt: Date.now() };
      const saved = await api.saveWorkflowDefinition(next);
      setDraft(saved);
      setNewDraftIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(saved.id);
        return nextIds;
      });
      await load(saved.id);
      return saved;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; } finally { setBusy(false); }
  };
  const start = async (): Promise<void> => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const inputs = Object.fromEntries(saved.inputs.map((input) => [input.key, parseInputValue(input.type, runInputs[input.key] ?? "") ]));
      const run = await api.startWorkflowRun(saved.id, inputs);
      const activeNode = run.definition.nodes.find((node) => {
        const status = run.nodeRuns[node.id]?.status;
        return status === "running" || status === "waiting";
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); setMode("run"); setSelectedNodeId(activeNode?.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const updateRun = (run: WorkflowRun): void => setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
  const changeRunState = async (operation: () => Promise<WorkflowRun>): Promise<void> => {
    setBusy(true); setError(undefined);
    try { updateRun(await operation()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const updateNode = (node: WorkflowNode): void => setDraft((current) => current ? { ...current, nodes: current.nodes.map((item) => item.id === node.id ? node : item) } : current);
  const pickWorkDir = async (): Promise<void> => {
    if (!draft || isTemplate) return;
    setBusy(true); setError(undefined);
    try {
      if (newDraftIds.has(draft.id)) {
        const snapshot = await api.chooseWorkDir();
        setGlobalWorkDir(snapshot.workDir);
      } else {
        const selected = await api.pickDirectory(draft.workDir || globalWorkDir);
        if (selected) {
          const saved = await api.saveWorkflowDefinition({ ...draft, workDir: selected, updatedAt: Date.now() });
          setDraft(saved);
          setDefinitions((current) => current.map((item) => item.id === saved.id ? saved : item));
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const clearWorkDir = async (): Promise<void> => {
    if (!draft || isTemplate || newDraftIds.has(draft.id) || !draft.workDir) return;
    setBusy(true); setError(undefined);
    try {
      const saved = await api.saveWorkflowDefinition({ ...draft, workDir: null, updatedAt: Date.now() });
      setDraft(saved);
      setDefinitions((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const clonePersonalWorkflow = async (definition: WorkflowDefinition): Promise<void> => {
    setPersonalMenu(undefined); setBusy(true); setError(undefined);
    try {
      const saved = await api.saveWorkflowDefinition(createWorkflowCopy(definition));
      setDefinitions((current) => [saved, ...current]);
      setSelectedId(saved.id); setDraft(structuredClone(saved)); setSelectedNodeId(undefined); setDefinitionInspectorOpen(false); setMode("definition");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const deletePersonalWorkflow = async (definition: WorkflowDefinition): Promise<void> => {
    setPersonalMenu(undefined);
    if (!window.confirm(localize(language, `Delete ${definition.name}?`, `确定删除「${definition.name}」吗？`))) return;
    setBusy(true); setError(undefined);
    try {
      await api.deleteWorkflowDefinition(definition.id);
      await load();
      setSelectedNodeId(undefined); setDefinitionInspectorOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const menuDefinition = personalMenu ? personalDefinitions.find((definition) => definition.id === personalMenu.definitionId) : undefined;

  return <div className="automation-page automation-workflow-page workflow-core-page" data-page="workflows">
    <header className="app-page-head automation-page-head"><div><h2>Workflow</h2><p>{localize(language, "Build dependable automations from explicit inputs, nodes, and described outputs.", "用明确的输入、节点和带描述的输出构建可靠自动化。")}</p></div></header>
    <div className="workflow-core-shell">
      <aside className="workflow-core-list"><header><strong>Workflows</strong><button type="button" className="icon-btn" aria-label="New Workflow" onClick={createNewWorkflow}><Plus size={16} /></button></header>
        <div>{templates.length > 0 ? <section className="workflow-core-list-group is-template"><header><span><LayoutTemplate size={11} /> 模板</span><small>{templates.length}</small></header>{templates.map((definition) => <button type="button" key={definition.id} className={definition.id === selectedId ? "is-active" : ""} onClick={() => selectDefinition(definition)}><strong>{definition.name}</strong><span>预览</span><small>{definition.description}</small></button>)}</section> : null}<section className="workflow-core-list-group"><header><span><UserRound size={11} /> 我的 Workflow</span><small>{personalDefinitions.length}</small></header>{personalDefinitions.length > 0 ? personalDefinitions.map((definition) => <button type="button" key={definition.id} className={definition.id === selectedId ? "is-active" : ""} onClick={() => selectDefinition(definition)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); const position = { definitionId: definition.id, x: event.clientX, y: event.clientY }; setPersonalMenu(position); void api.getWorkflowCore(definition.id).then((snapshot) => { const hasActiveRun = snapshot.runs.some((run) => run.status === "running" || run.status === "paused" || run.status === "waiting"); setPersonalMenu((current) => current?.definitionId === definition.id ? { ...current, hasActiveRun } : current); }).catch(() => { setPersonalMenu((current) => current?.definitionId === definition.id ? { ...current, hasActiveRun: true } : current); }); }}><strong>{definition.name}</strong><span>{definition.nodes.length} nodes</span><small>{definition.description}</small></button>) : <p>还没有自己的 Workflow</p>}</section></div>
      </aside>
      {personalMenu && menuDefinition ? <div className="agent-context-menu workflow-core-context-menu" style={{ left: personalMenu.x, top: personalMenu.y }} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" className="agent-context-menu-item" disabled={busy} onClick={() => void clonePersonalWorkflow(menuDefinition)}><Copy size={13} /><span>{localize(language, "Clone", "克隆")}</span></button>
        <button type="button" className="agent-context-menu-item danger" disabled={busy || personalMenu.hasActiveRun !== false} onClick={() => void deletePersonalWorkflow(menuDefinition)}><Trash2 size={13} /><span>{localize(language, "Delete", "删除")}</span></button>
      </div> : null}
      {!draft ? <main className="workflow-core-empty">Create a Workflow to begin.</main> : <main className="workflow-core-main">
        <header className="workflow-core-toolbar"><div className="workflow-core-toolbar-leading"><button type="button" className="workflow-core-title" onClick={() => { if (isTemplate) return; setSelectedNodeId(undefined); setDefinitionInspectorOpen(true); }}><strong>{draft.name}</strong><span>{draft.nodes.length} nodes · {isTemplate ? "只读模板" : `${draft.inputs.length} inputs`}</span></button>{!isTemplate ? <div className="workflow-core-mode"><button type="button" className={mode === "definition" ? "is-active" : ""} onClick={() => setMode("definition")}>Definition</button><button type="button" className={mode === "run" ? "is-active" : ""} onClick={() => { setMode("run"); setDefinitionInspectorOpen(false); }}>Current run{activeRun ? ` · ${activeRun.status}` : ""}</button></div> : <span className="workflow-core-template-badge"><LayoutTemplate size={11} /> 模板预览</span>}</div><div className="workflow-core-toolbar-actions">
          {isTemplate ? <button type="button" className="send-btn compact" disabled={busy} onClick={() => void useTemplate()}><Copy size={13} /> 使用模板</button> : <>{mode === "definition" ? <button type="button" className="icon-btn" title="Workflow properties" aria-label="Workflow properties" onClick={() => { setSelectedNodeId(undefined); setDefinitionInspectorOpen(true); }}><Settings2 size={14} /></button> : null}<button type="button" className="control-btn compact" disabled={busy} onClick={() => void save()}><Save size={13} /> Save</button>{activeRun?.status === "running" ? <><button type="button" className="control-btn compact" disabled={busy} onClick={() => void changeRunState(() => api.pauseWorkflowRun(activeRun.id))}><Pause size={13} /> 暂停</button><button type="button" className="control-btn compact is-danger" disabled={busy} onClick={() => void changeRunState(() => api.cancelWorkflowRun(activeRun.id))}><Square size={12} /> 取消</button></> : activeRun?.status === "paused" ? <><button type="button" className="send-btn compact" disabled={busy} onClick={() => void changeRunState(() => api.resumeWorkflowRun(activeRun.id))}><Play size={13} /> 继续</button><button type="button" className="control-btn compact is-danger" disabled={busy} onClick={() => void changeRunState(() => api.cancelWorkflowRun(activeRun.id))}><Square size={12} /> 取消</button></> : activeRun?.status === "waiting" ? <button type="button" className="control-btn compact is-danger" disabled={busy} onClick={() => void changeRunState(() => api.cancelWorkflowRun(activeRun.id))}><Square size={12} /> 取消</button> : <button type="button" className="send-btn compact" disabled={busy || issues.length > 0} onClick={() => void start()}><GitBranch size={13} /> Run</button>}<button type="button" className="icon-btn" aria-label="Delete Workflow" disabled={busy || activeRun?.status === "running" || activeRun?.status === "paused" || activeRun?.status === "waiting"} onClick={() => void deletePersonalWorkflow(draft)}><Trash2 size={14} /></button></>}
        </div></header>
        {error ? <div className="workflow-core-banner is-error">{error}</div> : null}
        {issues.length > 0 && mode === "definition" && !isTemplate ? <div className="workflow-core-banner"><strong>{issues.length} definition issue{issues.length === 1 ? "" : "s"}</strong><span>{issues[0]!.path}: {issues[0]!.message}</span></div> : null}
        {mode === "run" && activeRun ? <RunStatusBar run={activeRun} /> : null}
        <div className="workflow-core-workbench">
          <WorkflowGraphCanvas definition={draft} run={activeRun} mode={isTemplate ? "definition" : mode} agents={agents} readOnly={isTemplate} selectedNodeId={selectedNodeId} onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); setDefinitionInspectorOpen(false); }} onPositionsChange={(positions) => { if (isTemplate) return; setDraft((current) => current ? { ...current, nodes: current.nodes.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node) } : current); }} />
          {mode === "definition" && !isTemplate ? <div className="workflow-core-add-dock">{nodeKinds.map(({ kind, label, icon: Icon }) => <button type="button" key={kind} onClick={() => { const next = addWorkflowNode(draft, kind, agents[0]?.id ?? ""); setDraft(next); setSelectedNodeId(next.nodes.at(-1)?.id); setDefinitionInspectorOpen(false); }}><Icon size={13} /> {label}</button>)}</div> : null}
          {!isTemplate && (mode === "run" ? Boolean(selectedNodeId) : Boolean(selectedNode || definitionInspectorOpen)) ? <aside key={`${mode}:${selectedNodeId ?? "definition"}`} className={`workflow-core-inspector${mode === "run" ? " is-run" : ""}`}><button type="button" className="workflow-core-inspector-close icon-btn" aria-label="Close inspector" onClick={() => { setSelectedNodeId(undefined); setDefinitionInspectorOpen(false); }}><X size={15} /></button>{mode === "run" ? <RunInspector run={activeRun} selectedNodeId={selectedNodeId} liveOutput={activeRun && selectedNodeId ? runStreams[workflowRunStreamKey(activeRun.id, selectedNodeId)] : undefined} onRetry={(nodeId) => void changeRunState(() => api.retryWorkflowNode(activeRun!.id, nodeId))} onApprove={(nodeId, decision) => void changeRunState(() => api.resolveWorkflowApproval(activeRun!.id, nodeId, { decision, comment: "" }))} /> : selectedNode ? <NodeInspector definition={draft} node={selectedNode} agentIds={agents} language={language} onChange={updateNode} onDelete={() => { setDraft((current) => current ? { ...current, nodes: current.nodes.filter((item) => item.id !== selectedNode.id).map((item) => ({ ...item, inputs: item.inputs.filter((input) => input.source !== "node" || input.nodeId !== selectedNode.id) } as WorkflowNode)) } : current); setSelectedNodeId(undefined); }} /> : <DefinitionInspector definition={draft} runInputs={runInputs} defaultWorkDir={globalWorkDir} isNewDraft={newDraftIds.has(draft.id)} language={language} onChange={setDraft} onPickWorkDir={() => void pickWorkDir()} onClearWorkDir={clearWorkDir} onRunInputChange={(key, value) => setRunInputs((current) => ({ ...current, [key]: value }))} />}</aside> : null}
        </div>
      </main>}
    </div>
  </div>;
}
