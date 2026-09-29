# Runtime

范围：V2 执行配置、Agent 和运行驱动。V1 不具备这套自动化 Runtime。本文覆盖路由和调用边界，不把内部保留的 chat/task 接口等同于产品一定提供同名页面。操作说明见 [V2 指南](../v2/guide.md)。

## 对象关系

- Runtime 表示执行后端类型，例如 Codex、Claude Code、API、DeepSeek Harness、Hermes、OpenCode、OpenClaw。
- 执行配置（channel）保存该后端的具体连接、模型等配置。配置存在不等于运行环境已可用，需要对应配置测试或实际执行验证。
- 配置 Agent 引用执行配置，供 Workflow、Eval 等调用方选择；执行配置可生成 `runtime-agent:<channelId>` 托管 Agent。未选择 Agent 的入口不能静默改用列表首项。
- 删除执行配置必须处理引用它的 Agent；删除 Agent 必须处理其消费者。用户保存入口在主进程检查引用后才能修改状态，不能只在 UI 中禁用按钮。

## 路由与接口

[驱动注册表](../../apps/main-2.0/src/automation/engine/main/hub/runtime/executor/agent-executor.ts)注册后端实现。[RuntimeDriver](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-driver.ts)声明支持的调用场景、执行模式和续接策略，不能因为实现了某个方法就推断所有场景均可用。

[RuntimeRouter](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-router.ts)在驱动执行前验证请求：

- 未注册驱动、场景/执行模式/续接策略不受支持时明确失败。
- `resume-required` 必须有 Runtime 会话引用；非 fresh 续接必须有对应状态 codec。
- 会话引用必须属于正确 Runtime。fresh 请求会去掉经过归属检查的旧引用，不能误续接另一段对话。
- 后端专属启动、协议与清理由相应驱动处理。Renderer 只通过桌面桥接请求操作。

## 生命周期和失败

Router 为调用建立 invocation 记录，将事件和原生 Session/Turn 引用关联起来。执行成功、失败、取消和超时是不同状态；一次性执行的退出回调不能重复交付。持久化调用记录失败时需要暴露失败，不能只显示后端输出就宣称调用成功。

取消和关闭必须走驱动的 stop、interrupt、detach 或 shutdown 生命周期，具体能力取决于驱动。创建了本地记录不等于子进程已启动，配置测试成功也不等于真实任务成功。工作目录、进程及临时资源的清理由持有它们的服务负责。

## 兼容与修改边界

- Runtime 状态由对应 codec 解释，不能把一个后端的持久化会话标识交给另一个后端。
- 新增驱动同时定义能力、请求校验、事件映射、状态兼容和清理行为；不在调用方散布临时分支绕过 Router。
- 执行配置和 Agent 引用变化需同时核对持久化恢复和删除校验；历史迁移不能被当作正常运行时的默认 Agent 回退。
- 详细历史引用处理见 [执行配置与 Agent 引用说明](../v2/runtime-config-agent-delete-integrity.md)。其中历史 Chat/Team 记录是数据兼容背景，不代表当前桌面导航。

## 实现与验证入口

- [AgentHub](../../apps/main-2.0/src/automation/engine/main/hub/agent-hub.ts)及[对应测试](../../apps/main-2.0/src/automation/engine/main/hub/agent-hub.test.ts)：配置 Agent 关系、托管 Agent、删除引用校验。
- [桌面 IPC](../../apps/main-2.0/src/main/ipc/automation.ts)及[对应测试](../../apps/main-2.0/src/main/automation-ipc.test.ts)：用户保存操作启用删除校验。
- [调用记录测试](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-router-invocation.test.ts)：调用状态、事件与原生会话关系。
- [DSH 生命周期测试](../../apps/main-2.0/src/automation/engine/main/hub/runtime/executor/dsh/dsh-runtime-lifecycle.test.ts)：一个后端的生命周期检查入口，不代表其他后端已经通过同样验证。

后端协议变动时运行对应驱动测试；更改通用路由时覆盖受影响的多个调用场景。测试不使用真实凭据、个人配置或真实用户会话。

## 请求、调用与原生会话

RuntimeRequest 表达期望执行的 runtimeId、executionMode、continuationPolicy 和可选 runtimeConversation。它是请求意图；invocation 则记录 AgentRecall 实际发起的一次调用；原生 Session/Turn 标识由驱动报告。这三种身份不得混用。

| 对象 | 关键内容 | 何时可信 |
| --- | --- | --- |
| 请求 | 后端、模式、续接策略、调用方上下文 | 经 Router 校验后可调度 |
| invocation | id、runtimeId、channelId、environmentId、startedAt | begin 持久化完成后 |
| Session binding | sessionId、可选 turnId、created/continued | 观察到后端明确报告并保存后 |
| 终态 | completed/failed/cancelled/timed_out | finish 持久化完成后 |

类型由 [RuntimeInvocationRecorder](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-invocation-recorder.ts)维护。正常生产 wiring 未提供持久化 recorder 时，在调度前失败；仅测试允许显式使用 no-op recorder。

## 持久化顺序

1. 校验驱动、场景、模式、续接引用与归属。
2. 保存 pending invocation，再启动执行。
3. 接收后端事件，持久化真实 Session/Turn 绑定。
4. 保存完成、失败、取消或超时状态，再发布对应终态。

后端在失败前创建的会话仍应关联到 invocation。相反，续接请求在后端返回真实引用之前失败，不能仅按请求里的 sessionId 伪造成功绑定。resume-preferred 后端新建了会话时记录 created，而不是根据请求意图记 continued。

一次性执行的异步事件与退出回调通过队列协调。记录绑定失败不能被随后的完成回调覆盖；空退出码按取消语义处理，不能直接记为成功。设计取舍见 [ADR 0004](../adr/0004-runtime-invocation-ledger.md)。

## 能力矩阵维护

当前注册表有 Codex、Claude、API、DSH、Hermes、OpenCode 和 OpenClaw 驱动，但支持的场景与续接模式并不保证相同。新增调用路径先询问驱动能力，不通过“某函数存在”或 provider 名字猜测。

| 变化 | 必须同时核对 |
| --- | --- |
| 增加执行场景 | surfaceSupport、Router 验证、调用方错误展示 |
| 增加续接策略 | codec、原生引用归属、失败后的绑定行为 |
| 增加事件 | 事件类型、记录顺序、UI 消费和终态判定 |
| 修改 stop/interrupt | 进程退出、异步回调排空、取消/超时保留 |
| 修改 channel/Agent | 引用删除校验、历史恢复、持久化顺序 |

## 可恢复失败与边界

配置缺失、驱动不支持、后端执行失败、调用历史写入失败分别报告。不能为了让执行继续而绕过缺失 recorder，也不能在自动重试时重放可能已经产生外部效果的调用而不核对状态。

持久化错误信息先清理凭据形态数据并限制长度；原生标识有长度与归属约束。显示诊断信息不能成为保存凭据或整份环境变量的通道。

## 验收场景

| 场景 | 期望结果 |
| --- | --- |
| 未注入生产 recorder | 驱动启动前失败 |
| 不支持的执行模式 | Router 拒绝，不换后端偷偷继续 |
| resume-required 没有会话引用 | 调度前失败 |
| 其他 Runtime 的会话 envelope | 拒绝使用 |
| 启动后立即失败但已产生 Session | 保留真实绑定和失败状态 |
| 续接在报告引用前失败 | 不伪造原生会话绑定 |
| 后端完成但绑定保存失败 | 不向调用方发布成功结果 |
| stop 与 onExit 竞争 | 最终状态一致，退出回调不重复 |
| timeout 触发 interrupt | 保留 timed_out，不覆盖成普通取消 |
| 只成功保存执行配置 | 页面不宣称真实任务已经执行成功 |

前九项对应 [Router 调用测试](../../apps/main-2.0/src/automation/engine/main/agents/runtime/runtime-router-invocation.test.ts)及各驱动生命周期测试；最后一项属于产品状态表达，需要对应页面交互验证。
