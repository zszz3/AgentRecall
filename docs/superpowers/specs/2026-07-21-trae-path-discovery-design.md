# Trae 双目录路径发现设计

## 背景

TRAE 官方版使用 `.trae`，TRAE CN 使用 `.trae-cn`。当前默认发现只扫描 `.trae-cn`，导致官方版的本地 memory 会话漏扫。

## 决策

- 默认开启 Trae 来源时，按 `.trae`、`.trae-cn` 顺序扫描两个固定根目录。
- 不使用 `.trae*` 通配符，不扫描其他目录。
- 不做去重，不修改 Trae 会话的 source、rawId 或 sessionKey。
- 显式传入根目录的 `loadTraeSessions(root)` 行为保持单根目录扫描。
- 无参数 `loadTraeSessions()` 默认根目录改为官方 `.trae`。

## 验证

使用临时 home 和合成 JSONL fixture 覆盖单目录、双目录和显式根目录场景；文档同步列出 `.trae-cn` 与 `.trae` 两个固定路径。
