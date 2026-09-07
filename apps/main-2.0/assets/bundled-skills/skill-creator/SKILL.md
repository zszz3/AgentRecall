---
name: skill-creator
description: Use when creating, packaging, reviewing, or improving an Agent Skill for Codex, Claude, Trae, or another SKILL.md-compatible runtime.
---

# Skill Creator

Turn repeatable expertise into a small, discoverable Skill rather than a one-off prompt.

## Define the contract

Before writing files, establish:

1. Which concrete user situations should trigger the Skill.
2. The expected result and what counts as success.
3. Required tools, permissions, dependencies, and supported runtimes.
4. Dangerous actions that require explicit confirmation.
5. Two realistic positive examples and one nearby case that should not trigger.

## Package

Create a kebab-case directory containing `SKILL.md`. Put only `name` and a trigger-focused `description` in required frontmatter. Keep the main instructions concise and imperative. Move large references into `references/`, deterministic operations into `scripts/`, and reusable templates into `assets/`.

Do not assume a tool exists because another runtime provides it. Describe capabilities and prerequisites explicitly. Never embed secrets, machine-specific absolute paths, or instructions that silently transmit or delete user data.

## Validate

- Confirm the name matches the directory and uses only letters, numbers, and hyphens.
- Verify frontmatter parses and referenced files exist.
- Run realistic prompts with and without the Skill when the environment supports evaluation.
- Check that the Skill improves the intended result, does not trigger on unrelated requests, and degrades clearly when dependencies are unavailable.
- Keep changes small; revise instructions based on observed failures rather than adding broad rules speculatively.

## Install target

When the user requests direct installation, choose the runtime explicitly: `~/.codex/skills/<name>`, `~/.claude/skills/<name>`, or `~/.trae/skills/<name>`. Refuse to overwrite an unrelated existing directory without confirmation. For this application, user-created Skills remain user resources and must not be written into the bundled official catalog.
