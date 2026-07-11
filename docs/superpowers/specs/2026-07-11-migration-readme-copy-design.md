# Migration README Copy Simplification

## Scope

Replace the verbose cross-Agent migration overview in the Chinese and English READMEs with one concise sentence.

## Approved Copy

- Chinese: `支持在 Claude Code、Codex、CodeBuddy 及已启用的扩展 CLI 间迁移本地会话；远程恢复仍支持 Claude Code、Codex 和 CodeBuddy。`
- English: `Migrate local sessions between Claude Code, Codex, CodeBuddy, and enabled optional CLIs; remote restore remains available for Claude Code, Codex, and CodeBuddy.`

## Constraints

- Change only the migration overview line in `README.md` and `docs/README.en.md`.
- Keep the existing source table and Optional source notes unchanged.
- Intentionally remove the long-session compression and data-retention detail from this feature overview so the bullet stays concise.
- Do not change product behavior, tests, or generated artifacts.
