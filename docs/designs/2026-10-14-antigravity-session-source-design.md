# Antigravity 只读会话来源设计

## 文档状态

- 状态：只读来源 `antigravity`（桌面版）与 `antigravity-cli`（`agy` CLI）已在 V1 与 V2 实现，含会话 DB 补齐、token 用量、子会话父子关系与标题（默认关闭，需要用户在设置中开启）
- 适用范围：`apps/main-1.0` 与 `apps/main-2.0` 的会话索引
- 主要读者：负责实现、审查和验证会话来源的维护者
- 内容类型：设计说明与格式参考

本文定义 Google Antigravity 本地会话的发现、解析与索引契约，覆盖桌面版（2.13.0）与官方 `agy` CLI（1.3.5）。格式事实来自对这两个真实安装数据的分析，并与此前已核实的社区逆向结论互相印证（见文末参考）。Antigravity 是闭源产品，Google 未公开该格式；官方 [antigravity-cli](https://github.com/google-antigravity/antigravity-cli) 仓库只发布二进制与文档、不含源码，因此本文是当前 checkout 的唯一权威说明。

## 要解决的问题

Antigravity 是常见的同类编码代理之一，但 AgentRecall 此前无法索引它的会话。它的数据目录位于 `~/.gemini/` 之下，与 Gemini CLI 共享父目录、格式完全不同，因此不能复用 Gemini CLI 的来源实现。

## 目标

- 只读索引本机 Antigravity 会话：消息、思维链、工具调用与结果、上下文压缩标记、代理间消息。
- 恢复会话所属工作区路径、默认分支与会话标题，用于分组与展示。
- 用会话 DB 补齐转录缺失的信息：失败/中止的工具结果、逐次调用的 token 用量。
- 恢复子代理会话与派生它的会话之间的父子关系。
- 与现有可选来源一致：默认关闭、开启后增量索引、关闭后清理索引；源文件永不被修改或删除。
- 对格式漂移保持容错：未知条目类型被忽略并保留已解析内容，不使整批失败。

## 非目标

- 不提供 Antigravity CLI 的实时流、`/resume` 或会话导出；两个来源都只做离线只读索引。
- 不提供 live 跟踪、恢复、迁移、团队会话同步或"在应用中打开"能力（capabilities 全为 false）。
- 不展示模型名：会话 DB 中只有配置 id 和混杂在提示文本里的模型串，无法可靠归属到单次会话，AgentRecall 也没有模型展示位。
- 不索引 `conversations/*.db` 中未出现在 `brain/` 的会话（例如仅剩归档注解的已删除会话）。
- 不实现 `~/.gemini/antigravity-ide/`、`-backup`、`-acp`、`.config/antigravity` 等未经本机验证的候选路径（社区适配器列出了它们，见参考）。

## 数据结构（实测）

```
~/.gemini/antigravity-cli/                  # `agy` CLI 根目录：brain/、conversations/ 与桌面版同构
~/.gemini/antigravity/                      # 桌面版根目录（Windows/macOS/Linux 同构）
├── brain/<会话id>/.system_generated/logs/
│   ├── transcript_full.jsonl               # 主数据源：逐行 JSON，长字段不截断
│   ├── transcript.jsonl                    # 同一条目集合，长字段截断并标注 truncated_fields
│   └── chunks/transcript*/                 # 滚动分片副本，内容与 transcript 相同（备用）
├── conversations/<会话id>.db              # SQLite：steps 表（protobuf payload，不读）+ 轨迹元数据
├── annotations/<会话id>.pbtxt             # 文本 protobuf：标题、归档状态、最近查看时间
~/.gemini/config/projects/<项目id>.json    # 项目注册表（folderUri、名称），由元数据字段 18 关联
```

转录条目（每行一个对象）：

| 字段 | 说明 |
|---|---|
| `step_index` | 会话内序号；**转录按写入顺序追加，不是 step_index 顺序** |
| `source` | `USER_EXPLICIT` / `MODEL` / `SYSTEM` |
| `type` | `USER_INPUT`、`PLANNER_RESPONSE`、`GENERIC`、`CHECKPOINT`、`ERROR_MESSAGE`、`SYSTEM_MESSAGE` |
| `status` | `DONE` / `RUNNING`（实时写入） |
| `created_at` | ISO 8601 UTC |
| `content` / `thinking` / `tool_calls` / `media` | 可选；`tool_calls[i]` 为 `{ name, args }`；`media[i]` 为 `{ mime_type, uri }`（或内联 base64 `data` / `inline_data`） |

DB `steps.step_type` 与转录类型的对应（逐条 join 验证）：`14→USER_INPUT`、`15→PLANNER_RESPONSE`、`132→GENERIC`（工具结果）、`17→ERROR_MESSAGE`、`23→CHECKPOINT`（同一步骤还带标题更新）、`101→SYSTEM_MESSAGE`（代理间/后台任务消息）。`status=3` 已完成、`6` 中止、`7` 失败；失败与中止的步骤不写入转录，因此转录是"可见视图"（实测 6 个会话共丢 9 条失败的工具步），这些步骤由会话 DB 补齐。

`steps.step_payload` 是 protobuf wire format。字段含义用"转录当标准答案"逐条比对验证（覆盖 113/179 步的 step_type 自检、208 个用量字段、9 个失败步骤）：

| 字段 | 含义 |
|---|---|
| 1（varint） | step_type 的自检值，与实际 `step_type` 列完全一致（实测 113/113） |
| 5（message） | Cortex 步骤元数据：`1` = 时间戳 {1: 秒, 2: 纳秒}；`4` = 工具调用 {1: callId, 2: 名称, 3: 参数 JSON}；`9` = 用量 {2: 新输入, 5: 缓存输入, 9: 思考输出, 10: 可见输出} |
| 19（message） | 用户输入：`2` = 文本（与转录 `<USER_REQUEST>` 内容一致） |
| 20（message） | 模型回复：`1` = 文本、`3` = 思考、`7`（可重复）= 工具调用 {1: callId, 2: 名称, 3: 参数 JSON} |
| 24（message） | `ERROR_MESSAGE` 步骤的错误：`3.2` = 消息文本 |
| 30（message） | 标题更新步骤：`4` = 会话标题 |
| 31（message） | 工具失败信息：`2`/`3` = 错误文本 |
| 140（message） | 工具结果：`2` = 输出文本 |

用量自洽性：`3 = 9 + 10` 在全部 208 个有用量字段的步骤成立；单次 prompt 总量为 `2 + 5`。字段 2 不含字段 5 的缓存读取：两版本合计 236 个用量步（桌面版 208、CLI 28）里有 196 步 `5 > 2`，若 2 已含 5 则不可能出现；CLI 转录中 15 个有缓存步的 `input_tokens` 同样全部小于 `cache_read_tokens`。因此总量按 `2 + 5 + 3` 相加即可，不需要像 Codex/OpenAI 口径那样先从输入里减掉缓存。失败步骤的工具调用 id 与规划步 `20.7.1` 中的 id 相同，可据此把补出的结果对回已有调用。

工作区恢复：`conversations/<id>.db` 的 `trajectory_metadata_blob(id='main')` 是一个小型 protobuf（wire format，字段少且稳定）：

- 字段 1：工作区描述（1.1 `file:///` folderUri、1.3 git {1: slug, 2: url}、1.4 默认分支）
- 字段 2：轨迹创建时间戳（秒）
- 字段 18：项目 id，对应 `config/projects/<id>.json`

只解码字段 1.1 与 1.4（工作区与分支），不做 `steps`/`step_payload` 的 schema 逆向。

## 行为契约

### 发现与身份

- 根目录：`<homeDir>/.gemini/antigravity`（源 `antigravity`）与 `<homeDir>/.gemini/antigravity-cli`（源 `antigravity-cli`）；两者共用下面的布局与解析规则，`homeDir` 来自加载选项，测试用临时目录注入。
- 会话枚举 `brain/*/`，其 `.system_generated/logs/` 下存在可用转录（优先 `transcript_full.jsonl`，回退 `transcript.jsonl`）才成为会话。`chunks/` 分片与转录内容重复且边界语义未验证，不参与读取。
- 身份：`rawId = 会话目录名`（UUID），`sessionKey = "<source>:<uuid>"`，`filePath = 转录文件`。
- 父子关系：元数据字段 5 记录派生它的会话。字段 5 等于本会话 id 的自引用按根会话处理（旧版本这样写）；子代理会话的字段 5、6 都是父会话 id，因此只与自身 id 比较。子会话标记 `isSubagent` 并保留 `parentSessionId`。
- 新鲜度：以转录文件 mtime/size 判定；`conversations/<id>.db` 与 `annotations/<id>.pbtxt` 的 mtime 作为 dependency 参与变更判定（元数据变化需要重新索引）。
- 工作区：`projectPath` 取元数据 folderUri 的本地路径；缺失时回退 `filePath`。`gitBranch` 取元数据字段 1.4。
- 标题：注解 `title:` 优先，其次会话 DB 的标题更新（最后一条 `t23` 的字段 30.4），再次首条用户请求，最后会话 id。
- 时间戳：元数据创建时间优先，其次首条条目 `created_at`，最后文件 mtime。

### 条目映射

| 转录条目 | 映射 |
|---|---|
| `USER_INPUT` | 用户消息；提取 `<USER_REQUEST>…</USER_REQUEST>`，剥离 `<ADDITIONAL_METADATA>`/`<USER_SETTINGS_CHANGE>` 等系统块；解析 `media` 数组为附件，纯媒体无正文时保留 `[Attachment]` 消息（但不将该占位符作为 `firstQuestion` 或标题回退） |
| `PLANNER_RESPONSE` | `thinking` → 推理事件；`content` → 助手消息（同时解析 `media` 附件，纯媒体响应保留 `[Attachment]`）；`tool_calls` → 工具调用事件（`antigravity.toolCall`，`callId = antigravity:<stepIndex>:<i>`，提取 `toolSummary`/`CommandLine`/`Path`/`AbsolutePath`/`Url`/`queries`/`Role`/`Recipient`/`Action+TaskId`/`questions` 等单行参数摘要）；`input_tokens`/`output_tokens`/`cache_read_tokens`（CLI 转录自带）→ 逐次 TokenUsageEvent |
| `GENERIC` | 工具结果事件（`antigravity.toolResult`），优先按会话 DB 记录的真实调用 id 配对，无 DB 信息时按 step_index 顺序配对；剥离 `Created At:`/`Completed At:` 头行，无待配对调用时按助手文本处理。CLI 转录会保留失败步（`status: "ERROR"` 与 `error` 字段），此时结果状态取 `failed`、detail 取 `error` |
| `CHECKPOINT` | 上下文压缩事件（`antigravity.context.compaction`），detail 为截断摘要 |
| `ERROR_MESSAGE` | 失败事件（`antigravity.error`，`status = failed`） |
| `SYSTEM_MESSAGE` | 代理间/后台任务消息事件（`antigravity.collaboration.message`） |
| 未知类型 | 忽略，不失败 |

工具结果与调用一一配对：优先用会话 DB 里每个结果步记录的真实调用 id（字段 5.4.1）匹配，顺序配对只作为无 DB 时的回退——转录缺失失败结果步时，纯顺序配对会把后续结果贴到错误的调用上。配对不依赖工具名或参数结构（`args` 同时存在 PascalCase 与 lowercase 两种命名，原样透传）。转录里没有结果的调用是失败或中止的工具步，由会话 DB 补出。

会话 DB 补齐（DB 存在且可读时，附加在转录结果之上）：

- 失败/中止的工具步补一条 `antigravity.toolResult`：`callId` 由字段 5.4.1 的真实调用 id 映射回 `antigravity:<stepIndex>:<i>`，`status` 取 `failed`（7）或 `aborted`（6），detail 依次取字段 31.2、`error_details` 列文本、字段 140.2 输出，时间取字段 5.1。
- 规划步的用量（字段 5.9）生成逐次 TokenUsageEvent，去重键 `antigravity:<stepIndex>`，时间取该步的 `created_at`；`cachedInputTokens = 5`、`inputTokens = 2`、`outputTokens = 10`、`reasoningOutputTokens = 9`。
- 标题在注解缺失时取 DB 标题。
- 以上任一步失败只丢失对应补充信息，转录索引结果不变。
- DB 用量回填需要一个可展示的时间戳：某一步的转录行没有 `created_at` 时跳过该步的用量事件（无时间的用量无法进入时间线），其余步骤不受影响。

两个来源的差异（都不影响同一套解析规则）：

- CLI 转录自带逐次用量，桌面版转录没有；加载器优先采用转录里的用量，只有转录未报告该步时才用 DB 的字段 5.9。
- CLI 转录保留失败与后台运行的步骤（`status: "ERROR"`、`"RUNNING"`，后者只在转录里出现 `Created At` 与任务说明），桌面版转录会丢弃失败步。DB 补出的失败结果只在转录没有报告同一步时追加。
- CLI 没有 `annotations/` 目录，标题来自 DB 字段 30.4 或首个提问。

### 失败与边界

- `conversations/`、`annotations/`、`brain/` 任一目录缺失时静默返回空集合（这是未安装 Antigravity 的正常状态）；单个会话解析失败不影响其他会话。
- 元数据 protobuf、注解 pbtxt、`steps` 表、未知 wire type 均按"尽力而为"处理：解析失败只丢失工作区、标题、用量或失败结果，会话仍按转录索引。
- 源目录只读：不写入、不移动、不删除任何 Antigravity 文件；删除会话仅删除本地索引记录。
- 不做 tail-append 增量：转录在压缩与重写场景下可能整体重写，按文件级 mtime/size 全量重读。

## 接入点（两版本一致）

- 注册表行：`optionalSetting: "includeAntigravity"`、`pendingKey: "antigravity"`、`uiFamily: "other"`、capabilities 全 false。
- 加载器：V1 `core/session-loader.ts`（两个 generator）；V2 `core/session-loaders/alternative-sources.ts` 导出 `loadAntigravitySessionsIterator`，在 `core/session-loader.ts` 的两个 generator 派发。
- 开关链路：`AppSettings.includeAntigravity`、worker payload、worker 协议白名单、设置界面开关、关闭后 prune（注册表驱动，自动生效）。
- 只读删除门：`canDeleteSessionLocally` 与批量删除服务的只读名单（V1 四处、V2 四处）。
- 事件呈现：`trace-presentation.ts` 增加 `antigravity.thought`（reasoning）、`antigravity.collaboration.*`（collaboration）、`antigravity.context.compaction`（context）、`antigravity.error`（lifecycle/turn_summary）。
- 接入附件物化：`session-attachments.ts` 在受控本地路径白名单中放行 `<root>/brain/<会话id>` 及 `~/.gemini/antigravity` / `~/.gemini/antigravity-cli`，支持 `file://` URI（含 Windows 盘符路径）与同会话媒体缓存物化，并维持目录/叶节点符号链接逃逸校验。
- 验证：单元测试覆盖见 [V1 测试](../../apps/main-1.0/src/core/session-loader-antigravity.test.ts) 与 [V2 测试](../../apps/main-2.0/src/core/session-loader-antigravity.test.ts)。

## 分期

- 已完成（Phase 1）：桌面版转录索引，只读。
- 已完成（Phase 2）：用会话 DB 补齐失败与中止的工具结果、逐次 token 用量和 DB 标题。
- 已完成（Phase 3）：`antigravity-cli` 来源，以及对两个来源都生效的子会话父子关系。CLI 与桌面版共用 `brain/` 布局、转录格式和 `steps` 表 schema（字段 1 自检 63/63、转录用量与 DB 字段 5.9 逐条相等），因此复用同一套解析器，只按根目录区分来源与 key 前缀。
- 未决：`chunks/` 与转录的边界差异（少 1 行）语义；版本升级后的格式漂移；社区适配器列出的其它候选根目录（`-ide`、`-backup`、`-acp`、`.config/antigravity`）。

## 验证

- 单元测试：`apps/*/src/core/session-loader-antigravity.test.ts`，合成 fixture 覆盖顺序重排、用户请求提取、工具配对与未闭合调用、失败/中止结果的 DB 补全、token 用量、压缩标记、错误条目、代理间消息、未知条目忽略、注解与 DB 标题、protobuf 元数据、缺失回退与开关默认关闭。
- 注册表不变量：`session-sources.test.ts`（V1 有序来源数组、可选来源开关数组）。
- 字段验证：用转录作为标准答案对真实 DB 做逐条比对——桌面版 step_type 自检 113/113、CLI 63/63 一致；桌面版 208 个用量字段满足 `3 = 9 + 10`，CLI 的 28 个用量步转录值与 DB 字段 5.9 逐条相等；9 个失败步骤的调用 id 全部能在规划步中找到且有错误文本；5/6 桌面会话能取到 DB 标题；父子关联由字段 5 与自身 id 比对得出，桌面版 3/3 子代理正确归属。
- 手工核对：对 Antigravity 2.13.0 与 CLI 1.3.5 的真实安装运行加载器。桌面版 6 个会话（含 3 个子代理指向同一父会话）、CLI 1 个会话的标题、工作区、消息数、工具调用与结果数、逐次用量、失败结果状态、压缩标记与代理间消息均与源数据一致；两个来源的全部工具调用都与结果闭合（unpaired = 0）。
- 回归对照：两版本全量测试的失败项与本分支基线逐一相同（Windows 路径与进程探测类既有失败），未新增失败。

## 参考

- [rajbos/ai-engineering-fluency · antigravity-session-format.md](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/logFilesSchema/antigravity-session-format.md)：转录字段与 `<USER_REQUEST>` 结构的公开格式说明；其中记录的 `conversations/*.pb` 已被本机的 `*.db` 取代。
- [shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp)：CLI 会话 DB 读取与恢复出的 protobuf 定义。其 `ToolRun`（字段 5.1 取工具调用）针对的是 agy 1.2.12，与本机 1.3.5 的字段 5 布局不同；它的 schema 也没有用量字段，对应其仍未实现的用例[issue #20](https://github.com/shubzkothekar/antigravity-acp/issues/20)（本机已验证的字段 5.9 用量分桶可直接用于该用例，已据此提交 [PR #26](https://github.com/shubzkothekar/antigravity-acp/pull/26)）。
- [ccusage/ccusage · rust/adapters/antigravity](https://github.com/ccusage/ccusage/tree/main/rust/adapters/antigravity)：独立实现的用量适配器，其 token 分桶（input / total_output / cache_read / reasoning / visible_output）与本机验证的字段 2/3/5/9/10 完全对应；同时列出六个候选数据根目录（`.gemini/antigravity`、`-cli`、`-ide`、`-backup`、`-acp`、`.config/antigravity`）与 `ANTIGRAVITY_DATA_DIR` 覆盖，可作为后续多根目录支持的输入。
- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[Pika-Yalei/antigravity-decryptor](https://github.com/Pika-Yalei/antigravity-decryptor)：经语言服务器访问 Antigravity，依赖运行时进程，不适用于离线只读索引。
