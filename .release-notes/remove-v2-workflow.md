# V2 移除 Workflow 并整理界面

<!-- release-target: both -->

## 新增功能

- V2 移除 Workflow 功能（编辑器、运行、团队 Workflow 模板与 workflow MCP），专注会话、Agent、Eval 与团队资产；升级后已有的 Workflow、运行记录和产物会被清除，由 Workflow 发起的会话仍保留可查。

## Bug 修复

- 「今日」用量改为与昨天同一时刻之前的用量对比，不再出现早上显示接近 -100% 的情况。
- V2 工作台在 Codex 和 Claude Code 都没有订阅额度时隐藏模型额度卡片，不再只显示不可用提示。
- V2 页面标题与侧栏名称保持一致，Runtime 页面的配置状态和额度提示改为跟随界面语言显示。
- V2 只连接了一个团队时，打开团队空间直接进入该团队；Eval 中的 Skill 标签更名为「Skill 表现」。
