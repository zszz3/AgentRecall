export interface StarterPlanDimension {
  name: string;
  priority: "must" | "should";
  criterion: string;
}

function buildJudgePrompt(
  role: string,
  dimensions: readonly StarterPlanDimension[],
  guidance: string,
  hardRules: readonly string[],
): string {
  const contract = JSON.stringify(
    dimensions.map(({ name, priority }) => ({ name, priority })),
  );
  return `${role}

每个维度必须独立判断并引用 Answer 中的直接证据。一个维度的优点不能抵消另一个维度的实质缺陷。

<DimensionContract>${contract}</DimensionContract>

<Rubric>
${dimensions.map(
  (dimension, index) => `${index + 1}. ${dimension.name}（${dimension.priority}）：${dimension.criterion}`,
).join("\n")}
</Rubric>

<TaskGuidance>
${guidance}
</TaskGuidance>

<ScoreAnchors>
0：完全缺失、方向相反，或有会让交付不可用的严重问题。
0.25：触及该维度，但有重大错误或关键链路断裂。
0.5：核心方向可用，但仍有一个重要缺口或多处含混。
0.75：主要要求满足，仅有不妨碍使用和核对的轻微问题。
1：完整、准确、可核对，没有该维度下的实质缺陷。
</ScoreAnchors>

<HardRules>
${hardRules.map((rule) => `- ${rule}`).join("\n")}
</HardRules>

<Input>{{input}}</Input>
<Context>{{context}}</Context>
<GroundTruth>{{ground_truth}}</GroundTruth>
<Answer>{{output}}</Answer>

只返回一个 JSON 对象，不要添加 Markdown。verdicts 必须恰好包含 DimensionContract 中的 ${dimensions.length} 个维度，名称完全一致且不重复：
{"verdicts":[{"dimension":"维度名称","score":0,"reason":"简体中文理由","evidence":["Answer 中的直接证据"],"failedCriteria":["具体未满足项"]}]}`;
}

export const TECHNICAL_DESIGN_DIMENSIONS: readonly StarterPlanDimension[] = [
  {
    name: "任务理解与阶段聚焦",
    priority: "must",
    criterion: "识别当前是需求澄清、方案比较还是已批准设计，并只完成该阶段应交付的内容。",
  },
  {
    name: "事实证据与假设边界",
    priority: "must",
    criterion: "已知事实、待确认信息和设计假设被区分，关键结论不靠编造的仓库或运行事实支撑。",
  },
  {
    name: "范围约束与验收条件",
    priority: "must",
    criterion: "目标、非目标、约束、成功标准和待决问题足以约束实现与评审。",
  },
  {
    name: "方案选择与权衡质量",
    priority: "should",
    criterion: "需要比较时给出真正不同的方案、成本与风险，并形成有理由的推荐和批准边界。",
  },
  {
    name: "架构职责与接口边界",
    priority: "must",
    criterion: "组件职责、调用方向、输入输出、权限边界和外部依赖清晰，没有把表现层、运行时和持久化混为一体。",
  },
  {
    name: "状态数据与生命周期",
    priority: "must",
    criterion: "关键状态和数据由谁写、何时写、存在哪里、存活多久、如何读取与恢复都有明确归属。",
  },
  {
    name: "并发幂等与失败恢复",
    priority: "must",
    criterion: "并发所有权、取消、超时、重试、幂等、部分失败、清理和恢复语义与方案风险相匹配。",
  },
  {
    name: "验证发布与回滚",
    priority: "should",
    criterion: "测试层级、可观测信号、兼容或迁移策略、发布步骤和回滚条件能够证明并安全交付方案。",
  },
  {
    name: "决策清晰与可评审性",
    priority: "should",
    criterion: "结论、理由、开放问题和下一批准点清楚，结构让评审者能定位风险并作出决定。",
  },
] as const;

// There is no {{metadata}} placeholder, so the stage has to be read off the task
// the judge is given rather than off dataset metadata or the Answer itself.
export const TECHNICAL_DESIGN_JUDGE_PROMPT = buildJudgePrompt(
  "你是技术方案评审员。当前阶段以 Input 与 Context 的表述为准，不要从 Answer 反推阶段，否则一份越界交付的答案会自己把评审标准放宽到越界的那一档。据此评估 Answer 的九个质量维度，包括内容是否服务于当前阶段。",
  TECHNICAL_DESIGN_DIMENSIONS,
  `- discovery：高质量答案应提出一个最高价值的澄清问题并说明其决策影响；克制地不展开完整设计是优点，不因缺少架构、发布或回滚细节扣分。
- approaches：重点评估 2 至 3 个可行方案的实质差异、权衡、推荐理由和进入详细设计前的批准点；尚未展开完整生命周期不是缺陷。
- approved_design：按可实施方案评审，要求范围、架构、接口、数据与状态、并发与恢复、兼容、测试、可观测、发布和回滚形成闭环。`,
  [
    "把未知仓库事实、运行结果或产品行为写成已确认事实时，「事实证据与假设边界」不得高于 0.25。",
    "把串行写成并行、把重试等同于幂等、把内存状态写成持久化时，相关 must 维度不得高于 0.25。",
    "不得因 discovery 或 approaches 阶段没有提前交付 approved_design 的细节而扣分。",
    "approved_design 缺少影响安全交付的状态、失败或回滚语义时，相关 must 维度不得高于 0.5。",
  ],
);

export const ONE_BITE_TEACHING_DIMENSIONS: readonly StarterPlanDimension[] = [
  {
    name: "单点聚焦",
    priority: "must",
    criterion: "只讲当前最重要的一个概念，没有扩写成大而全的教程或引入无关分支。",
  },
  {
    name: "事实准确与证据",
    priority: "must",
    criterion: "解释与输入材料和真实语义一致，明确区分已知事实、推断和无法确认的边界。",
  },
  {
    name: "因果链与运行机制",
    priority: "must",
    criterion: "用触发、动作、状态或结果的短链路讲清为什么会得到该结论，而非只给定义。",
  },
  {
    name: "具体例子与可理解性",
    priority: "should",
    criterion: "用最小例子、对照或输入输出帮助读者建立直觉，例子不喧宾夺主。",
  },
  {
    name: "边界与易混概念",
    priority: "must",
    criterion: "点出最容易混淆的相邻概念或失败边界，避免形成错误迁移。",
  },
  {
    name: "认知顺序与节奏",
    priority: "should",
    criterion: "先给结论或具体路径，再补必要机制，信息密度适合一次只吃一口。",
  },
  {
    name: "表达简洁自然",
    priority: "should",
    criterion: "中文具体、自然、少术语堆砌和空泛报幕，没有重复结论。",
  },
] as const;

export const ONE_BITE_TEACHING_JUDGE_PROMPT = buildJudgePrompt(
  "你是一口式技术教学评审员。评估 Answer 是否在很小的认知切片内，把一个关键区别讲准确、讲明白。",
  ONE_BITE_TEACHING_DIMENSIONS,
  "以 Input 指定的单个问题为边界。GroundTruth 描述预期抓住的关键区别，不要求逐字匹配。若 Answer 用一个短例子或对照已经讲清，不应因为没有完整背景章节而扣分。",
  [
    "核心概念、执行顺序或错误边界讲反时，「事实准确与证据」和相关 must 维度不得高于 0.25。",
    "把一个点扩成多个平行主题、导致主线难以识别时，「单点聚焦」不得高于 0.5。",
    "不要因答案短而扣分；短但准确、完整覆盖当前认知切片可以得满分。",
  ],
);

export const STRUCTURED_OUTPUT_DIMENSIONS: readonly StarterPlanDimension[] = [
  {
    name: "语义正确性",
    priority: "must",
    criterion: "字段值正确表达 Input 的计算、分类或抽取结果，与 GroundTruth 不冲突。",
  },
  {
    name: "字段完整与类型合理",
    priority: "must",
    criterion: "任务要求的字段齐全，值的 JSON 类型、枚举和嵌套关系符合语义。",
  },
  {
    name: "指令约束遵循",
    priority: "must",
    criterion: "遵守只返回 JSON、字段限制和任务中的其他显式约束，没有夹带解释或 Markdown。",
  },
  {
    name: "最小输出与一致性",
    priority: "should",
    criterion: "不添加臆造或无关字段，相同概念在各字段间一致，输出可直接被下游消费。",
  },
] as const;

export const STRUCTURED_OUTPUT_JUDGE_PROMPT = buildJudgePrompt(
  "你是结构化输出评审员。JSON 语法合法性和关键结果包含关系由确定性检查负责；请评估合法 JSON 内部的语义与契约质量。",
  STRUCTURED_OUTPUT_DIMENSIONS,
  "以 Input 中要求的 JSON 结构为契约，结合 Context 和 GroundTruth 判断。不要因为 JSON 可解析就默认语义正确，也不要要求 Input 未声明的字段。",
  [
    "关键字段值错误或与 GroundTruth 冲突时，「语义正确性」不得高于 0.25。",
    "缺少显式必填字段或字段类型导致下游无法消费时，「字段完整与类型合理」不得高于 0.25。",
    "JSON 外出现解释文字、代码围栏或多个顶层结果时，「指令约束遵循」不得高于 0.25。",
  ],
);
