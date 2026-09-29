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
