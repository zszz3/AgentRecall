# AgentRecall 双应用独立 Release 设计

## 目标

AgentRecall V1 与 `agent-recall-v2` 在 GitHub Releases 中分别展示、分别编号、分别提供更新说明和安装包，不再合并到同一条 Release。

## 发布模型

- V1 延续现有 `v<version>` tag，例如 `v0.34.3`，并作为仓库的 Latest Release。
- V2 使用独立 `v2-<version>` tag，例如 `v2-0.1.1`，版本从 `apps/main-2.0` 自己的版本继续递增。
- Release note 通过 `release-target: v1|v2|both` 路由。只有收到相关 note 的应用才发布；`both` 会分别进入两条 Release。
- V1 与 V2 各自以上一次产品 tag 为增量边界。V2 第一次发布以 `v0.34.2` 作为一次性的历史边界，避免收集 monorepo 之前的 V1 note。

## 资产隔离

V1 Release 只包含：

- `agent-recall-<version>.tgz`
- `agent-recall.tgz`
- `update.json`

V2 Release 只包含：

- `agent-recall-v2-<version>.tgz`
- `agent-recall-v2.tgz`
- `update-v2.json`

两套安装包分别生成校验和并在发布前从对应 draft Release 下载复验。

## 更新发现

- V1 保持使用仓库 Latest Release。
- V2 从 GitHub Release 列表中只选择 `v2-*` tag 和 `update-v2.json`，不会把更新检查或手动安装地址指向 V1。
- V2 的 OpenViking 运行时也从对应的 `v2-*` Release 下载。

## 验证

- 版本计算测试覆盖 V1 忽略 V2 tag、V2 独立递增。
- 发布资产测试覆盖两套 tag、URL、文件名和校验和。
- 更新测试覆盖 V2 跳过更晚发布的 V1 Release。
- 工作流测试确认两条 Release 分别创建、上传和远端复验。
