# Release note format

Every independent development branch adds exactly one Markdown file in this directory.

```markdown
# 简短的用户可见标题

## 新增功能

- ✨ 描述用户现在能看到或使用的新功能。

## Bug 修复

- 描述已经解决的用户可见问题。
```

At least one section must contain a bullet. Omit an empty section. Pending bullets are aggregated into the next GitHub Release and displayed unchanged by the terminal and App update interfaces.

Write this as product copy for users, not as an engineering log. Keep only user-visible features and fixes. Do not mention MRs/PRs, branches, `main`, CI, GitHub Actions, commits, release mechanics, refactors, test counts, internal services, database details, or local paths. Remove internal-only changes. Rewrite useful outcomes to omit private identifiers, hosts, paths, table names, credentials, and organizational details. A few appropriate emoji are welcome when they help users scan the text.
