import { createEvaluationNodeRegistry, type EvaluationNodeRegistry } from "./graph/builder";
import { createEvaluationNodeDefinitions } from "./case-graph";
import type { EvaluationNodeRole } from "./graph/node";
import type { EvaluationPortMap } from "./graph/ports";
import {
  ARTIFACT_COMPLETE_NODE_TYPE,
  FOLDER_ARTIFACT_NODE_TYPE,
  RUN_AGENT_NODE_TYPE,
  SESSION_ARTIFACT_NODE_TYPE,
  SESSION_LINK_NODE_TYPE,
  SKILL_PROVISION_NODE_TYPE,
  SKILL_USE_OBSERVE_NODE_TYPE,
  TASK_SOURCE_NODE_TYPE,
} from "./nodes/prepare-nodes";
import {
  DETERMINISTIC_JUDGE_NODE_TYPE,
  LLM_JUDGE_NODE_TYPE,
  SCRIPT_JUDGE_NODE_TYPE,
  SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE,
  TOOL_FAILURE_JUDGE_NODE_TYPE,
  TRAJECTORY_BUDGET_JUDGE_NODE_TYPE,
} from "./nodes/judge-nodes";

/**
 * What an editor needs to know about the node set.
 *
 * Ports are read from the real node definitions rather than restated here, so a
 * palette can never advertise a port the engine does not have. Only the
 * editor-facing parts — display names and which config fields a node takes — are
 * declared, because the engine has no opinion about them.
 */

export type EvaluationConfigFieldKind =
  /** One of the configured execution Agents. */
  | "agent"
  /** One of the stored datasets, or a folder of cases picked from disk. */
  | "dataset"
  /** An installed skill name, or empty for "inject nothing". */
  | "skill"
  /** One of the saved evaluators; also fills kind, threshold, prompt and runtime. */
  | "evaluator"
  | "number";

export interface EvaluationConfigFieldDescriptor {
  key: string;
  kind: EvaluationConfigFieldKind;
  required: boolean;
  labelEn: string;
  labelZh: string;
}

export interface EvaluationPortDescriptor {
  name: string;
  kind: string;
}

export interface EvaluationNodeCatalogEntry {
  type: string;
  role: EvaluationNodeRole;
  labelEn: string;
  labelZh: string;
  descriptionEn: string;
  descriptionZh: string;
  inputs: EvaluationPortDescriptor[];
  outputs: EvaluationPortDescriptor[];
  configFields: EvaluationConfigFieldDescriptor[];
  /**
   * The task node's config is the case itself, so a run overwrites whatever the
   * editor saved. Marked here so an editor does not offer to fill it in.
   */
  configuredPerCase?: boolean;
}

interface CatalogPresentation {
  labelEn: string;
  labelZh: string;
  descriptionEn: string;
  descriptionZh: string;
  configFields: EvaluationConfigFieldDescriptor[];
  configuredPerCase?: boolean;
}

const DIMENSION_FIELDS: EvaluationConfigFieldDescriptor[] = [
  { key: "evaluatorId", kind: "evaluator", required: true, labelEn: "Evaluator", labelZh: "评分器" },
];

const PRESENTATION: Record<string, CatalogPresentation> = {
  [TASK_SOURCE_NODE_TYPE]: {
    labelEn: "Task",
    labelZh: "任务",
    descriptionEn: "Emits the case under evaluation.",
    descriptionZh: "产出当前被评测的用例。",
    configFields: [],
    configuredPerCase: true,
  },
  [SKILL_PROVISION_NODE_TYPE]: {
    labelEn: "Skill injection",
    labelZh: "Skill 注入",
    descriptionEn: "Reads a skill's instructions and freezes its version into the run.",
    descriptionZh: "读取 Skill 说明并把其版本固定到本次运行。",
    configFields: [
      { key: "skillName", kind: "skill", required: false, labelEn: "Skill", labelZh: "Skill" },
    ],
  },
  [RUN_AGENT_NODE_TYPE]: {
    labelEn: "Run agent",
    labelZh: "跑模型",
    descriptionEn: "Produces the artifact by running the agent once on the task.",
    descriptionZh: "让 Agent 执行一次任务，产出被评测的产物。",
    configFields: [
      { key: "agentId", kind: "agent", required: true, labelEn: "Agent", labelZh: "Agent" },
    ],
  },
  [SESSION_LINK_NODE_TYPE]: {
    labelEn: "Session link",
    labelZh: "会话关联",
    descriptionEn: "Finds the session a fresh run produced, yielding its trajectory.",
    descriptionZh: "找到本次运行产生的会话，取出它的轨迹。",
    configFields: [
      { key: "attempts", kind: "number", required: false, labelEn: "Attempts", labelZh: "重试次数" },
      { key: "delayMs", kind: "number", required: false, labelEn: "Delay (ms)", labelZh: "间隔（毫秒）" },
    ],
  },
  [ARTIFACT_COMPLETE_NODE_TYPE]: {
    labelEn: "Artifact files",
    labelZh: "产物文件",
    descriptionEn: "Adds the files a fresh run's session shows to its artifact, so judges read what the report reads.",
    descriptionZh: "把本次运行的会话所见到的文件补进产物，让评分器读到的和报告读到的是同一份。",
    configFields: [],
  },
  [SESSION_ARTIFACT_NODE_TYPE]: {
    labelEn: "Session artifact",
    labelZh: "已有会话",
    descriptionEn: "Evaluates a session that already happened; nothing is re-run.",
    descriptionZh: "评测已经发生过的会话，不重跑任何东西。",
    configFields: [],
    configuredPerCase: true,
  },
  [FOLDER_ARTIFACT_NODE_TYPE]: {
    labelEn: "Folder artifact",
    labelZh: "产物文件夹",
    descriptionEn: "Evaluates a folder on disk. A folder has no trajectory.",
    descriptionZh: "评测磁盘上的产物目录。文件夹没有轨迹。",
    configFields: [],
    configuredPerCase: true,
  },
  [SKILL_USE_OBSERVE_NODE_TYPE]: {
    labelEn: "Skill use",
    labelZh: "Skill 使用",
    descriptionEn: "Records whether the injected skill was used. Never affects the score.",
    descriptionZh: "记录注入的 Skill 是否被使用，不影响评分。",
    configFields: [],
  },
  [DETERMINISTIC_JUDGE_NODE_TYPE]: {
    labelEn: "Check",
    labelZh: "确定性判定",
    descriptionEn: "Exact match, substring or JSON shape on the artifact. No model involved.",
    descriptionZh: "对产物做精确匹配、包含或 JSON 合法性判定，不调用模型。",
    configFields: DIMENSION_FIELDS,
  },
  [LLM_JUDGE_NODE_TYPE]: {
    labelEn: "LLM judge",
    labelZh: "模型评判",
    descriptionEn: "Scores the artifact with a judge model, on one dimension.",
    descriptionZh: "用评判模型给产物打分，归属一个维度。",
    configFields: DIMENSION_FIELDS,
  },
  [TOOL_FAILURE_JUDGE_NODE_TYPE]: {
    labelEn: "Tool failures",
    labelZh: "工具失败",
    descriptionEn: "Decides on the trajectory: how many tool calls failed.",
    descriptionZh: "对轨迹判定：有多少工具调用失败。",
    configFields: DIMENSION_FIELDS,
  },
  [TRAJECTORY_BUDGET_JUDGE_NODE_TYPE]: {
    labelEn: "Trajectory budget",
    labelZh: "轨迹预算",
    descriptionEn: "Decides on the trajectory: what the work spent against the budgets you set.",
    descriptionZh: "对轨迹判定：这次工作的开销是否超出你设定的预算。",
    configFields: DIMENSION_FIELDS,
  },
  [SCRIPT_JUDGE_NODE_TYPE]: {
    labelEn: "Script judge",
    labelZh: "脚本评判",
    descriptionEn: "Scores the artifact with your own code, inline or a command.",
    descriptionZh: "用你自己的代码给产物打分，可写内联 JS 或调用外部命令。",
    configFields: DIMENSION_FIELDS,
  },
  [SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE]: {
    labelEn: "Script judge (trajectory)",
    labelZh: "脚本评判（轨迹）",
    descriptionEn: "Scores how the work was done with your own code.",
    descriptionZh: "用你自己的代码给做事过程打分。",
    configFields: DIMENSION_FIELDS,
  },
};

/**
 * A registry usable for building and validating a graph, but not for running it.
 *
 * The node factories need host dependencies to execute; structural validation
 * needs only their declared ports. The stubs make the distinction explicit
 * instead of letting an unrunnable registry look like a working one.
 */
export function createEvaluationValidationRegistry(): EvaluationNodeRegistry {
  return createEvaluationNodeRegistry(
    createEvaluationNodeDefinitions({
      runAgent: () => {
        throw new Error("The validation registry cannot execute nodes.");
      },
    }),
  );
}

export function evaluationNodeCatalog(): EvaluationNodeCatalogEntry[] {
  return createEvaluationValidationRegistry().list().map((definition) => {
    const presentation = PRESENTATION[definition.type];
    if (!presentation) {
      throw new Error(`Evaluation node ${definition.type} has no catalog presentation.`);
    }
    return {
      type: definition.type,
      role: definition.role,
      ...presentation,
      inputs: describePorts(definition.inputs as EvaluationPortMap),
      outputs: describePorts(definition.outputs as EvaluationPortMap),
    };
  });
}

function describePorts(ports: EvaluationPortMap): EvaluationPortDescriptor[] {
  return Object.entries(ports).map(([name, spec]) => ({ name, kind: spec.kind }));
}
