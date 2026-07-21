---
name: handoff
description: Use when pausing a long task, changing sessions or runtimes, or preparing another agent to continue unfinished work.
---

# Handoff

Produce a compact, evidence-based continuation record for a fresh agent.

## Gather current state

- Identify the user's latest goal and any later corrections that supersede earlier instructions.
- Record the repository, branch, worktree state, relevant commits, and whether changes are committed or pushed.
- List completed work with concrete file paths and behavior, not a chronological conversation recap.
- List remaining work in dependency order. Include exact failing commands, errors, process IDs, ports, or external blockers when relevant.
- Reference existing specs, plans, diffs, and artifacts instead of duplicating their contents.
- Capture validation already run and its exact result. Never imply unrun checks passed.

## Protect the user

Remove API keys, tokens, passwords, cookies, personal identifiers, and unrelated local information. Do not tell the next agent to overwrite or discard uncommitted work unless the user explicitly requested it.

## Format

```markdown
# Handoff
## Goal
## Current state
## Completed
## Remaining
## Key files
## Verification
## Constraints and decisions
## Suggested skills
## Resume command
```

Keep it short enough to read at session start. Save it to the operating system's temporary directory when file tools are available; otherwise return the Markdown directly. End with one exact command or action that safely resumes the work.
