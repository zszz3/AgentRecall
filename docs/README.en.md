<h1 align="center">AgentRecall</h1>

<p align="center">Search, inspect, and resume Claude Code and Codex sessions on your computer</p>

<p align="center">
  <a href="../README.md">简体中文</a> ｜ English
</p>

AgentRecall solves one focused problem: coding-agent sessions are scattered across projects and tools, so finding where you left off can take longer than continuing the work. It provides one desktop search entry for local Claude Code and Codex sessions.

Core search and inspection happen locally and do not require uploading sessions. AgentRecall builds its own local index and does not write organization metadata back to upstream session files. See the [privacy, read/write, and network matrix](./privacy-network-matrix.md) for optional network features and exact boundaries.

## Install

Download the appropriate asset from [GitHub Releases](https://github.com/zszz3/AgentRecall/releases):

- macOS: choose an arm64 or x64 DMG for your Mac, or the matching zip.
- Windows: choose the x64 NSIS installer.

If an asset is absent from the Release page, that platform has not been published. A source build is not a substitute for validating a release installer. See the [native distribution guide](./native-distribution.md) for signing, updates, rollback, and uninstall behavior. npm installation remains a development fallback documented in [advanced usage and development](./advanced-usage-and-development.md).

## Search → Inspect → Resume

1. **Search** across projects using a phrase you remember.
2. **Inspect** the messages, Markdown, code blocks, and tool-call context.
3. **Resume** with the original agent and project.

Resume invokes an installed Claude Code or Codex CLI; AgentRecall does not replace either tool.

## Documentation

- [Advanced usage, data locations, development, and troubleshooting](./advanced-usage-and-development.md)
- [Privacy, read/write, and network matrix](./privacy-network-matrix.md)
- [1.0 release gate](./release-gate-1.0.md)
- [Demo assets and launch copy](./launch-assets.md)

## License

[MIT](../LICENSE)
