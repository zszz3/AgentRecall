import type {
  EvaluationDataset,
  EvaluationDatasetItem,
  EvaluationEvaluator,
  EvaluatorKind,
} from "./evaluation/types";
import { JUDGE_PROMPTS } from "./evaluation/evaluator-prompts";

export interface EvaluationDatasetTemplate {
  id: string;
  name: string;
  description: string;
  category: "coding" | "structured" | "tools" | "instruction" | "writing";
  items: Array<Omit<EvaluationDatasetItem, "id" | "sequence">>;
}

export interface EvaluationEvaluatorTemplate {
  id: string;
  name: string;
  description: string;
  category:
    | "deterministic"
    | "answer-quality"
    | "grounding"
    | "instruction"
    | "safety"
    | "specialized";
  kind: EvaluatorKind;
  prompt?: string;
  threshold: number;
}

export const DATASET_TEMPLATES: EvaluationDatasetTemplate[] = [
  {
    id: "code-review",
    name: "代码审查基础集",
    description: "检查 Agent 发现安全、正确性和并发问题的能力。",
    category: "coding",
    items: [
      {
        input:
          "审查以下代码并指出最严重的问题：\nconst user = db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);",
        expectedOutput: "SQL 注入",
        metadata: { topic: "security", language: "javascript" },
      },
      {
        input:
          "审查以下 Go 代码的并发安全性：\nvar count int\nfunc Add() { go func() { count++ }() }",
        expectedOutput: "数据竞争",
        metadata: { topic: "concurrency", language: "go" },
      },
      {
        input:
          "审查权限判断：\nif (request.userId) { return loadDocument(request.documentId) }",
        expectedOutput: "越权",
        metadata: { topic: "authorization" },
      },
    ],
  },
  {
    id: "structured-json",
    name: "结构化 JSON 输出",
    description: "验证 Agent 能否严格按照指定 Schema 返回 JSON。",
    category: "structured",
    items: [
      {
        input:
          "只返回 JSON：从句子『张三在上海，负责支付系统』提取 {name, city, responsibility}。",
        metadata: { schema: "entity" },
      },
      {
        input:
          "只返回 JSON 数组：将『修复登录问题；补充单测；周五发布』拆成任务，每项包含 title 和 status。",
        metadata: { schema: "tasks" },
      },
      {
        input:
          "只返回 JSON：判断 18 是否为偶数，格式为 {value, isEven, explanation}。",
        metadata: { schema: "boolean_reasoning" },
      },
    ],
  },
  {
    id: "tool-selection",
    name: "工具选择准确性",
    description: "测试 Agent 是否能根据任务选择正确的工具或能力。",
    category: "tools",
    items: [
      {
        input:
          "用户要求查询北京未来三天的天气。你应该优先使用什么工具？只回答工具名称。",
        expectedOutput: "weather",
        metadata: { capability: "weather" },
      },
      {
        input:
          "用户要求读取一个已知路径的本地截图。你应该优先使用什么工具？只回答工具名称。",
        expectedOutput: "view_image",
        metadata: { capability: "local_image" },
      },
      {
        input:
          "用户要求查找仓库中所有使用 deprecatedApi 的文件。你应该优先使用什么命令？只回答命令名称。",
        expectedOutput: "rg",
        metadata: { capability: "code_search" },
      },
    ],
  },
  {
    id: "instruction-following",
    name: "指令遵循",
    description: "覆盖格式限制、长度限制和明确禁止项。",
    category: "instruction",
    items: [
      {
        input: "只回答 YES 或 NO：2 + 2 是否等于 4？",
        expectedOutput: "YES",
        metadata: { constraint: "closed_answer" },
      },
      {
        input: "用恰好三个中文要点总结：可靠、快速、可观测。不要写标题。",
        metadata: { constraint: "count_and_language" },
      },
      {
        input: "将『系统运行正常』改写成英文，只输出翻译结果。",
        expectedOutput: "The system is running normally.",
        metadata: { constraint: "translation_only" },
      },
    ],
  },
  {
    id: "chinese-writing",
    name: "中文写作质量",
    description: "评估摘要、改写和专业表达，适合搭配表达质量 Judge。",
    category: "writing",
    items: [
      {
        input:
          "将这段话改写成简洁的产品更新：『我们这次做了很多优化，速度变快了，也修复了用户反馈的一些问题。』",
        metadata: { genre: "release_note" },
      },
      {
        input:
          "把这句话改成专业但不生硬的邮件表达：『你这个方案有问题，赶紧重新弄。』",
        metadata: { genre: "email" },
      },
      {
        input:
          "用不超过 80 个汉字总结：离线评测通过固定数据集、评分规则和运行历史，帮助团队持续发现 Agent 质量回退。",
        metadata: { genre: "summary", maxCharacters: 80 },
      },
    ],
  },
];

export const EVALUATOR_TEMPLATES: EvaluationEvaluatorTemplate[] = [
  {
    id: "exact-match",
    name: "精确匹配",
    description: "输出与期望结果完全一致。",
    category: "deterministic",
    kind: "exact_match",
    threshold: 1,
  },
  {
    id: "contains-expected",
    name: "包含期望内容",
    description: "输出包含 Dataset 中的期望文本。",
    category: "deterministic",
    kind: "contains",
    threshold: 1,
  },
  {
    id: "valid-json",
    name: "JSON 合法性",
    description: "输出必须能够解析为 JSON。",
    category: "deterministic",
    kind: "json_valid",
    threshold: 1,
  },
  {
    id: "hallucination",
    name: "幻觉检测",
    description: "判断回答中的事实是否得到 Context 或 Ground truth 支持。",
    category: "grounding",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.hallucination,
  },
  {
    id: "helpfulness",
    name: "有用性",
    description: "判断回答是否直接帮助用户完成目标。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.helpfulness,
  },
  {
    id: "relevance",
    name: "相关性",
    description: "判断回答是否聚焦用户问题。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.relevance,
  },
  {
    id: "toxicity",
    name: "安全与毒性",
    description: "识别侮辱、仇恨、骚扰和不当危险内容。",
    category: "safety",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS.toxicity,
  },
  {
    id: "correctness",
    name: "正确性",
    description: "依据任务、Ground truth 和 Context 判断事实与结论。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.correctness,
  },
  {
    id: "context-relevance",
    name: "Context 相关性",
    description: "判断提供的 Context 是否与用户问题相关。",
    category: "grounding",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["context-relevance"],
  },
  {
    id: "context-correctness",
    name: "Context 正确性",
    description: "判断 Context 是否支持 Ground truth 和最终结论。",
    category: "grounding",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["context-correctness"],
  },
  {
    id: "conciseness",
    name: "简洁性",
    description: "判断回答是否信息充分但不过度冗长。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.conciseness,
  },
  {
    id: "completeness",
    name: "完整性",
    description: "判断回答是否覆盖任务要求的全部关键部分。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.completeness,
  },
  {
    id: "clarity",
    name: "清晰度",
    description: "判断表达是否明确、易读且结构合理。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.clarity,
  },
  {
    id: "coherence",
    name: "逻辑连贯性",
    description: "判断结论、理由和步骤之间是否一致连贯。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.coherence,
  },
  {
    id: "instruction-following-judge",
    name: "指令遵循",
    description: "判断回答是否满足用户的明确要求与限制。",
    category: "instruction",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["instruction-following-judge"],
  },
  {
    id: "format-compliance",
    name: "格式合规",
    description: "判断输出是否严格满足指定结构、字段和格式。",
    category: "instruction",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS["format-compliance"],
  },
  {
    id: "language-consistency",
    name: "语言一致性",
    description: "判断回答语言、术语和语气是否符合要求并保持一致。",
    category: "instruction",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["language-consistency"],
  },
  {
    id: "refusal-quality",
    name: "拒答质量",
    description: "判断该拒绝时是否拒绝，以及拒绝是否克制且有帮助。",
    category: "safety",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["refusal-quality"],
  },
  {
    id: "code-quality",
    name: "代码质量",
    description: "评估代码答案的正确性、可维护性与工程风险。",
    category: "specialized",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["code-quality"],
  },
  {
    id: "reasoning-quality",
    name: "推理质量",
    description: "评估答案中可见的分析、证据和结论是否可靠。",
    category: "specialized",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS["reasoning-quality"],
  },
  {
    id: "laziness",
    name: "任务投入度",
    description: "识别占位符、推脱和用半成品代替实际交付。",
    category: "answer-quality",
    kind: "llm_judge",
    threshold: 0.75,
    prompt: JUDGE_PROMPTS.laziness,
  },
  {
    id: "fairness",
    name: "公平性",
    description: "识别无依据刻板印象和身份差别标准。",
    category: "safety",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS.fairness,
  },
  {
    id: "pii-leakage",
    name: "PII 泄漏",
    description: "检查未授权敏感个人信息、凭证和可识别数据。",
    category: "safety",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS["pii-leakage"],
  },
  {
    id: "injection-resistance",
    name: "提示注入抵抗",
    description: "判断 Agent 是否抵抗越权指令并继续合法任务。",
    category: "safety",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS["injection-resistance"],
  },
  {
    id: "code-security",
    name: "代码安全",
    description: "检查注入、越权、凭证泄漏和危险默认值。",
    category: "specialized",
    kind: "llm_judge",
    threshold: 1,
    prompt: JUDGE_PROMPTS["code-security"],
  },
];

export function instantiateDatasetTemplate(
  template: EvaluationDatasetTemplate,
  now = Date.now(),
): EvaluationDataset {
  const id = `dataset-${now}`;
  return {
    id,
    name: template.name,
    description: template.description,
    items: template.items.map((item, index) => ({
      ...item,
      id: `${id}-item-${index + 1}`,
      metadata: { ...item.metadata },
      sequence: index,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function instantiateEvaluatorTemplate(
  template: EvaluationEvaluatorTemplate,
  now = Date.now(),
): EvaluationEvaluator {
  return {
    id: `evaluator-${now}`,
    name: template.name,
    kind: template.kind,
    ...(template.prompt ? { prompt: template.prompt } : {}),
    threshold: template.threshold,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
