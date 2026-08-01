# Claude Skill 版本指纹修复

## Bug 修复

- 修复 Claude Skill 的触发时版本指纹（`skill_hash`）无法进入 Eval 数据库的问题：当本机存在 Claude 会话转录时，hook 日志被跳过，导致版本对比功能失效。现在 hook 日志始终参与扫描，`skill_hash` 会被合并到对应的会话事件中。
- 修复插件 Skill 无法计算版本指纹的问题：hook 脚本现在能搜索 `~/.claude/plugins` 下的插件 Skill 目录（包括 `installed_plugins.json` 和 `marketplaces` 两种路径），不再只查找 `~/.claude/skills/`。
