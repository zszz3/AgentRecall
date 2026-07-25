# AgentRecall 1.0 演示素材与发布文案

本文是可复用素材模板，不代表平台、性能、签名或发布状态已经验证。发布人必须删除未通过 1.0 门禁的结论，并用真实 Release 链接、版本号、截图和数据替换所有占位符。

## 一句话定位

在本机搜索、查看并继续 Claude Code 与 Codex 的历史会话。

## GitHub 元数据

**Description**

> Local desktop search for finding, inspecting, and resuming Claude Code and Codex sessions.

**Topics**

`claude-code`, `codex`, `ai-coding`, `session-search`, `developer-tools`, `desktop-app`, `electron`, `local-first`, `macos`, `windows`

不要添加 `all-agents`、`zero-network`、`privacy-guaranteed` 或未经门禁验证的性能 topic。

## 10 秒 GIF 分镜

GIF 应使用合成项目、合成会话和虚构路径，画面中不得出现真实姓名、仓库、客户信息、token 或终端历史。

| 时间 | 画面 | 操作与字幕 |
| --- | --- | --- |
| 0.0–1.5 s | 搜索窗出现，列表已有 Claude Code 与 Codex 合成会话 | 字幕：`上次做到哪里？` |
| 1.5–4.0 s | 输入一个具体关键词，结果收敛到 2–3 条 | 字幕：`跨项目搜索` |
| 4.0–7.0 s | 打开一条结果，快速扫过消息、Markdown 和代码块 | 字幕：`查看完整上下文` |
| 7.0–10.0 s | 点击 Resume，出现将由原 Agent 继续的确认或终端画面 | 字幕：`搜索 → 查看 → 继续` |

录制要求：1280×800 或 1440×900，焦点与鼠标可见，不加快到无法阅读；成片控制在 10 秒左右，首尾可无缝循环。

## 60 秒视频脚本

| 时间 | 画面 | 旁白 |
| --- | --- | --- |
| 0–7 s | 在两个项目和两个 Agent 窗口间切换，表现“找不到上次对话” | “Claude Code 和 Codex 用久了，真正难找的常常不是代码，而是上次那段会话。” |
| 7–15 s | 打开 AgentRecall | “AgentRecall 把本机历史会话放进一个桌面搜索入口。” |
| 15–27 s | 输入关键词并切换结果 | “输入你记得的错误、函数名或一句讨论，就能跨项目找到相关记录。” |
| 27–39 s | 打开详情，展示 Markdown、代码块、工具调用 | “打开结果，直接查看消息、Markdown、代码和工具调用上下文。” |
| 39–49 s | 点击 Resume | “确认就是这一段后，用原来的 Claude Code 或 Codex 接着工作。” |
| 49–56 s | 展示隐私矩阵中的核心行或设置界面 | “核心搜索在本机完成，整理信息保存在 AgentRecall 自己的数据里。” |
| 56–60 s | Logo、平台与 Release 链接 | “AgentRecall：搜索、查看、继续。到 GitHub Release 下载。” |

只有门禁通过后，才可在 49–56 秒加入“3 秒启动”“10k 会话 200 ms”“关闭更新后零请求”等实测结论，并同时在视频说明中给出测试口径。

## 3 张截图清单

1. **搜索主页**：同屏展示 Claude Code 与 Codex 的合成结果、关键词高亮和来源标识。不得出现真实项目名或路径。
2. **会话详情**：展示一段可读的 Markdown、代码块和工具调用，突出从命中片段回到上下文。
3. **Resume 确认/结果**：展示目标 Agent、合成项目和明确的继续操作；若平台行为不同，macOS 与 Windows 分别拍摄，不拼接成同一平台结论。

每张图都应记录版本、操作系统、架构和构建来源；发布图可裁掉这些信息，但验证记录必须保留原图。

## GitHub Release 模板

```markdown
# AgentRecall {{version}}

AgentRecall 帮你在本机搜索、查看并继续 Claude Code 与 Codex 的历史会话。

## 本次发布

- {{只填写用户可感知且已验证的新增功能}}
- {{只填写用户可感知且已验证的 Bug 修复}}

## 下载

- macOS arm64：{{dmg_url}} / {{zip_url}}
- macOS x64：{{dmg_url}} / {{zip_url}}
- Windows x64：{{nsis_url}}

如果没有对应平台资产，表示该平台本次未发布。

## 使用

搜索关键词 → 打开会话查看上下文 → 用原来的 Claude Code 或 Codex Resume。

## 已知限制

- {{来自 release gate 的 BLOCKED 或非阻断限制}}

安装、更新、回滚和卸载：{{docs_url}}
校验信息：{{checksums_or_signature_url}}
```

## V2EX 模板

**标题**

> [分享创造] AgentRecall 1.0：在本机找回 Claude Code / Codex 历史会话

**正文**

> 我经常记得“之前和 Agent 讨论过这个问题”，却不记得在哪个项目、哪个会话。AgentRecall 做的事情很简单：把本机 Claude Code 和 Codex 会话放到一个桌面搜索入口里。
>
> 核心流程只有三步：搜索关键词、查看上下文、用原 Agent 继续。核心搜索不要求上传会话，整理信息保存在应用自己的本地数据中。
>
> 支持的发布资产：{{只列 release gate 已通过的平台}}
>
> 10 秒演示：{{gif_url}}
> 下载与源码：{{release_url}}
>
> 当前限制：{{如实列出 BLOCKED 项和不支持范围}}。欢迎反馈具体的搜索、Markdown 或 Resume 问题。

## 掘金模板

**标题**

> 我做了一个本地会话搜索工具，找回 Claude Code 和 Codex 的“上次做到哪”

**提纲**

1. 痛点：会话按工具和项目散落，关键词记得、位置忘了。
2. 产品边界：本地索引、搜索、详情、Resume，不是全能 Agent 平台。
3. 演示：用合成会话走完“搜索 → 查看 → 继续”。
4. 隐私模型：上游只读、应用自有索引、可选联网能力分开说明。
5. 分发质量：安装、更新、回滚、卸载和未通过项目如何进入 release gate。
6. 下载：`{{release_url}}`；已知限制：`{{blocked_items}}`。

## 知乎模板

**问题/标题**

> Claude Code 和 Codex 的历史会话太多，怎样快速找回某次讨论？

**回答开头**

> 如果你记得错误信息、函数名或一句讨论，但忘了会话位置，可以用 AgentRecall 在本机统一搜索 Claude Code 与 Codex 历史。它不是替代 Agent 的聊天工具，而是把“搜索 → 查看 → 继续”缩短成一个流程。

回答正文应包含一组真实但脱敏的搜索例子、隐私矩阵截图、已验证平台和明确限制。结尾链接：`{{release_url}}`。

## X 模板

> Lost a useful Claude Code or Codex session? AgentRecall lets you search local history, inspect the full context, and resume with the original agent.
>
> Search → Inspect → Resume
> macOS/Windows: {{only_verified_platforms}}
> {{release_url}}
> {{gif_url}}

不要在一个帖子中写入未经门禁证明的启动或搜索耗时。

## Reddit 模板

**Title**

> I built a local desktop search for Claude Code and Codex sessions

**Body**

> I kept remembering a useful discussion but not which project or agent session contained it, so I built AgentRecall around one workflow: search a phrase, inspect the full context, then resume with the original CLI.
>
> Core search runs against a local app index and does not require uploading sessions. Optional network features are documented separately rather than hidden behind a broad “local” claim.
>
> Demo: {{gif_url}}
> Release/source: {{release_url}}
> Verified platforms: {{only_release_gate_passes}}
> Known limitations: {{blocked_items}}
>
> I would especially value reproducible feedback about search matching, Markdown rendering, and Resume behavior. Please use synthetic logs when sharing diagnostics.
