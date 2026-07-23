# Team Chat Agent Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex and Claude Code members keep an isolated, restart-safe Runtime conversation inside each Team Chat room, send only new room context on later turns, and let users explicitly start a fresh Agent conversation.

**Architecture:** `ConfiguredAgentExecutionService` exposes a continuation-aware execution method while preserving the existing fresh one-shot API. Team Chat stores opaque Runtime conversation envelopes in a private room-member session table, decorates public room members with boolean session status, and builds either a fresh recent transcript or a resumed incremental transcript. Renderer receives no native session identifiers and only calls a validated reset command.

**Tech Stack:** TypeScript, Electron IPC/preload, React, PostgreSQL/PGlite, Zod, Vitest.

---

## File map

- Create `src/main/team-chat/team-chat-store.ts`: persistence contract and private Agent-session types shared by Team Chat service and stores.
- Modify `src/automation/engine/main/platform/configured-agent-execution-service.ts`: continuation-aware configured-Agent execution.
- Modify `src/automation/engine/main/platform/configured-agent-execution-service.test.ts`: request-policy and result tests.
- Modify `src/shared/team-chat.ts`: safe public member continuity flags and reset request.
- Modify `src/main/team-chat/postgres-team-chat-store.ts`: session schema, persistence, member cleanup, and incremental message query.
- Modify `src/main/team-chat/pglite-team-chat-store.test.ts`: restart persistence using only a temporary database directory.
- Modify `src/main/team-chat/postgres-team-chat-store.test.ts`: SQL contract tests with the fake pool.
- Modify `src/main/team-chat/team-chat-routing.ts`: fresh/resume prompt variants and duplicate filtering.
- Modify `src/main/team-chat/team-chat-routing.test.ts`: prompt budget and delta-context tests.
- Modify `src/main/team-chat/team-chat-service.ts`: compatibility checks, session save/reset, incremental context, safe stale-session fallback.
- Modify `src/main/team-chat/team-chat-service.test.ts`: observable continuity behavior through a memory store.
- Modify `src/main/services/automation-service.ts`: route Team Chat through the new continuation-aware executor.
- Modify `src/shared/ipc/team-chat.ts`, `src/main/ipc/team-chat.ts`, `src/preload/team-chat.ts`: reset IPC.
- Modify `src/main/team-chat-ipc.test.ts`, `src/preload/team-chat.test.ts`: reset validation and mapping tests.
- Modify `src/renderer/src/features/team-chat/team-chat-page.tsx`: member continuity state and “new conversation” action.
- Modify `src/renderer/src/styles/team-chat.css`, `src/renderer/src/team-chat-ui.test.ts`: compact member-row styling and UI contract.
- Modify `.release-notes/feat-workflow-run-center-v1.md`: one user-facing bullet describing continuous room context and reset.

### Task 1: Continuation-aware configured-Agent execution

**Files:**
- Modify: `src/automation/engine/main/platform/configured-agent-execution-service.test.ts`
- Modify: `src/automation/engine/main/platform/configured-agent-execution-service.ts`

- [ ] **Step 1: Write failing request-policy tests**

Add tests that pass a synthetic `RuntimeConversation` to Codex and assert the underlying request contains:

```ts
expect(execute).toHaveBeenCalledWith(expect.objectContaining({
  executionMode: "oneshot",
  continuationPolicy: "resume-preferred",
  runtimeConversation,
}), expect.any(Function), expect.any(AbortSignal));
expect(result.runtimeConversation).toEqual(nextConversation);
```

Add a second case using an API configured Agent and assert it sends `continuationPolicy: "fresh"`, omits `runtimeConversation`, and still returns its text result.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/automation/engine/main/platform/configured-agent-execution-service.test.ts
```

Expected: FAIL because `runConversation` and continuation results do not exist.

- [ ] **Step 3: Implement the continuation-aware method**

Add:

```ts
const CONTINUABLE_WORKFLOW_RUNTIMES = new Set<RuntimeId>(["codex", "claude"]);

export function supportsConfiguredAgentConversation(runtimeId: RuntimeId): boolean {
  return CONTINUABLE_WORKFLOW_RUNTIMES.has(runtimeId);
}

async runConversation(
  input: {
    configuredAgentId: string;
    prompt: string;
    workDir?: string;
    runtimeConversation?: RuntimeConversation;
  },
  onEvent?: (event: WorkflowAgentEvent) => void,
  signal?: AbortSignal,
): Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }> {
  // Resolve the current Agent config.
  // Use resume-preferred only when the resolved Runtime supports the workflow continuation surface
  // and the supplied envelope belongs to that Runtime; otherwise use fresh and omit the envelope.
  // Return the cloned Runtime envelope from WorkflowAgentResponse without exposing it to Renderer.
}
```

Keep `runOneShot` fresh and make both public methods share one private execution body so Evaluation behavior does not change.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 Vitest command. Expected: all tests in the file pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/automation/engine/main/platform/configured-agent-execution-service.ts src/automation/engine/main/platform/configured-agent-execution-service.test.ts
git commit -m "feat(chat): support continued agent execution"
```

### Task 2: Persist private room-member sessions and incremental context

**Files:**
- Create: `src/main/team-chat/team-chat-store.ts`
- Modify: `src/main/team-chat/postgres-team-chat-store.ts`
- Modify: `src/main/team-chat/postgres-team-chat-store.test.ts`
- Modify: `src/main/team-chat/pglite-team-chat-store.test.ts`

- [ ] **Step 1: Write failing PGlite persistence tests**

Using the existing temporary directory fixture, insert a room, messages, and:

```ts
await first.upsertAgentSession({
  roomId: room.id,
  agentId: "builder",
  runtimeId: "codex",
  channelId: "codex-main",
  modelId: "gpt-5",
  runtimeConversation: {
    runtimeId: "codex",
    codecVersion: "1",
    payload: { native: { threadId: "thread-1" } },
  },
  lastContextMessageId: humanMessage.id,
  updatedAt: "2026-07-23T10:00:00.000Z",
});
```

Close and reopen the store, then expect `listAgentSessions(room.id)` to return the envelope. Add messages after the marker and assert `listMessagesAfter(room.id, marker, 2)` returns the latest two in chronological order with `truncated: true`.

- [ ] **Step 2: Run the PGlite test and verify RED**

```bash
npx vitest run src/main/team-chat/pglite-team-chat-store.test.ts
```

Expected: FAIL because session and incremental-context methods do not exist.

- [ ] **Step 3: Introduce the store boundary and schema**

Move `TeamChatStore` and `TeamChatDispatchUpdate` out of the service/store cycle into `team-chat-store.ts`, then add:

```ts
export interface TeamChatAgentSession {
  roomId: string;
  agentId: string;
  runtimeId: string;
  channelId: string;
  modelId: string;
  runtimeConversation: RuntimeConversation;
  lastContextMessageId?: string;
  updatedAt: string;
}

export interface TeamChatContextPage {
  messages: TeamChatMessage[];
  truncated: boolean;
}
```

Add `chat_agent_sessions` with a room foreign key, `(room_id, agent_id)` primary key, JSONB conversation, optional message marker, and update timestamp. Implement:

```ts
listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]>;
upsertAgentSession(session: TeamChatAgentSession): Promise<void>;
deleteAgentSession(roomId: string, agentId: string): Promise<void>;
listMessagesAfter(roomId: string, afterMessageId: string, limit: number): Promise<TeamChatContextPage>;
```

`updateRoom` must delete sessions only for members that were actually removed; renaming a room must preserve sessions.

- [ ] **Step 4: Add fake-Postgres SQL tests**

Assert schema initialization includes `chat_agent_sessions`, upsert parameters never serialize credentials outside the JSONB value, member removal emits a scoped cleanup query, and message-after pagination uses the marker tuple `(created_at, id)`.

- [ ] **Step 5: Run store tests and verify GREEN**

```bash
npx vitest run src/main/team-chat/postgres-team-chat-store.test.ts src/main/team-chat/pglite-team-chat-store.test.ts
```

Expected: both files pass and temporary files are cleaned by their existing `finally` blocks.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/main/team-chat/team-chat-store.ts src/main/team-chat/postgres-team-chat-store.ts src/main/team-chat/postgres-team-chat-store.test.ts src/main/team-chat/pglite-team-chat-store.test.ts src/main/team-chat/team-chat-service.ts src/main/team-chat/team-chat-service.test.ts
git commit -m "feat(chat): persist room agent conversations"
```

### Task 3: Build fresh and incremental prompts without duplicated messages

**Files:**
- Modify: `src/main/team-chat/team-chat-routing.test.ts`
- Modify: `src/main/team-chat/team-chat-routing.ts`

- [ ] **Step 1: Write failing prompt tests**

Add one fresh test proving the current triggering message appears exactly once. Add one resumed test:

```ts
const prompt = buildTeamChatPrompt({
  room,
  target: room.agents[0],
  messages: [ownPreviousReply, peerReply, currentTrigger],
  triggerMessage: currentTrigger,
  executedAgentIds: ["builder"],
  remainingExecutions: 7,
  continuing: true,
  contextTruncated: true,
});

expect(prompt).toContain("Room updates since your previous turn:");
expect(prompt).toContain("Reviewer: peer result");
expect(prompt).not.toContain("Builder: my old result");
expect(prompt.match(/current request/g)).toHaveLength(1);
expect(prompt).toContain("Earlier room updates were omitted");
```

- [ ] **Step 2: Run the routing test and verify RED**

```bash
npx vitest run src/main/team-chat/team-chat-routing.test.ts
```

Expected: FAIL because fresh prompts duplicate the trigger and resume mode is unavailable.

- [ ] **Step 3: Implement prompt modes**

Extend `buildTeamChatPrompt` with:

```ts
continuing?: boolean;
contextTruncated?: boolean;
```

Always remove `triggerMessage.id` from the transcript. In continuing mode also remove messages whose `senderAgentId` matches the target Agent. Use `Recent room transcript:` for fresh calls and `Room updates since your previous turn:` for resumed calls. Add the omission marker only when `contextTruncated` is true.

- [ ] **Step 4: Run the routing test and verify GREEN**

Run the Task 3 command. Expected: all routing tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/main/team-chat/team-chat-routing.ts src/main/team-chat/team-chat-routing.test.ts
git commit -m "feat(chat): send incremental room context"
```

### Task 4: Orchestrate compatible sessions, reset, and safe fallback

**Files:**
- Modify: `src/shared/team-chat.ts`
- Modify: `src/main/team-chat/team-chat-service.test.ts`
- Modify: `src/main/team-chat/team-chat-service.ts`
- Modify: `src/main/services/automation-service.ts`

- [ ] **Step 1: Write failing service continuity tests**

Extend the memory store with the Task 2 session methods. Test these observable cases separately:

1. First Codex reply saves the returned conversation.
2. A later call in the same room receives that envelope and an incremental prompt.
3. The same Agent in a different room receives no envelope.
4. Changing the configured Agent channel/model clears the incompatible envelope before execution.
5. `resetAgentSession(roomId, agentId)` clears only that member and returns a room with `hasActiveConversation: false`.
6. A recognized “session not found/expired” error with no emitted delta retries fresh once; a generic error and an error after a delta do not retry.

Use:

```ts
executeAgent: vi.fn(async (input, onEvent) => ({
  output: "continued",
  durationMs: 1,
  runtimeConversation: nextConversation,
}))
```

and assert public room members contain flags but no `runtimeConversation` property.

- [ ] **Step 2: Run the service test and verify RED**

```bash
npx vitest run src/main/team-chat/team-chat-service.test.ts
```

Expected: FAIL because Team Chat does not load, save, decorate, or reset Agent sessions.

- [ ] **Step 3: Add public flags and service behavior**

Extend `TeamChatRoomAgent` with:

```ts
continuationAvailable: boolean;
hasActiveConversation: boolean;
conversationUpdatedAt?: string;
```

Add `ResetTeamChatAgentSessionRequest`. In `TeamChatService`:

- Decorate rooms by joining configured Agents with private session rows.
- Delete a private row when its Runtime/Channel/Model snapshot differs.
- Use `listMessagesAfter` for compatible sessions and `listMessages` for fresh calls.
- Save the returned conversation with the latest context message ID after a successful reply.
- Retry fresh only when the error matches a narrow missing/expired-session classifier and no delta was emitted.
- Implement `resetAgentSession`.

Wire Team Chat through:

```ts
executeAgent: (input, onEvent, signal) =>
  configuredAgentExecutor.runConversation(input, onEvent, signal),
```

Evaluation remains on `runOneShot`.

- [ ] **Step 4: Run service and automation wiring tests**

```bash
npx vitest run src/main/team-chat/team-chat-service.test.ts src/main/services/automation-service.test.ts src/main/team-chat-wiring.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/shared/team-chat.ts src/main/team-chat/team-chat-service.ts src/main/team-chat/team-chat-service.test.ts src/main/services/automation-service.ts
git commit -m "feat(chat): continue room agent context"
```

### Task 5: Expose a safe reset command

**Files:**
- Modify: `src/shared/ipc/team-chat.ts`
- Modify: `src/main/ipc/team-chat.ts`
- Modify: `src/main/team-chat-ipc.test.ts`
- Modify: `src/preload/team-chat.ts`
- Modify: `src/preload/team-chat.test.ts`

- [ ] **Step 1: Write failing IPC and preload tests**

Expect one additional registered channel and:

```ts
await api.resetAgentSession({ roomId: "room-1", agentId: "builder" });
expect(ipc.invoke).toHaveBeenCalledWith(
  TEAM_CHAT_CHANNELS.agentSessionReset,
  { roomId: "room-1", agentId: "builder" },
);
```

In the main IPC test, reject missing/oversized IDs and assert a valid request delegates exactly once.

- [ ] **Step 2: Run IPC tests and verify RED**

```bash
npx vitest run src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts
```

Expected: FAIL because the channel and API method are missing.

- [ ] **Step 3: Implement the reset boundary**

Add `agentSessionReset: "team-chat:agent-session:reset"`, validate a strict `{ roomId, agentId }` object with the existing ID schema, delegate to `service.resetAgentSession`, and expose the typed preload method.

- [ ] **Step 4: Run IPC tests and verify GREEN**

Run the Task 5 command. Expected: both files pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/shared/ipc/team-chat.ts src/main/ipc/team-chat.ts src/main/team-chat-ipc.test.ts src/preload/team-chat.ts src/preload/team-chat.test.ts
git commit -m "feat(chat): add agent context reset"
```

### Task 6: Show continuity status in the member rail

**Files:**
- Modify: `src/renderer/src/team-chat-ui.test.ts`
- Modify: `src/renderer/src/features/team-chat/team-chat-page.tsx`
- Modify: `src/renderer/src/styles/team-chat.css`

- [ ] **Step 1: Write a failing UI contract test**

Assert the page contains `member.continuationAvailable`, `member.hasActiveConversation`, `api.resetAgentSession`, and localized labels for `Persistent context`, `Continues after first reply`, `New context each time`, and `Start new conversation`.

- [ ] **Step 2: Run the UI test and verify RED**

```bash
npx vitest run src/renderer/src/team-chat-ui.test.ts
```

Expected: FAIL because the member rail has no continuity controls.

- [ ] **Step 3: Implement the compact member row**

Replace the nested all-purpose member button with a row containing:

- A primary mention button with avatar, name, Runtime, and continuity label.
- A `RotateCcw` icon button only when `hasActiveConversation` is true.
- A busy set keyed by Agent ID so only the resetting member is disabled.

On reset, call the preload API, replace `activeRoom` with the returned room, clear old feedback on success, and preserve room messages. Add focused CSS selectors under `.team-chat-member-row`; keep the rail width unchanged.

- [ ] **Step 4: Run UI and type tests**

```bash
npx vitest run src/renderer/src/team-chat-ui.test.ts
npm run typecheck
```

Expected: UI contract passes and TypeScript exits 0.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/renderer/src/features/team-chat/team-chat-page.tsx src/renderer/src/styles/team-chat.css src/renderer/src/team-chat-ui.test.ts
git commit -m "feat(chat): expose persistent context controls"
```

### Task 7: Release note and complete verification

**Files:**
- Modify: `.release-notes/feat-workflow-run-center-v1.md`

- [ ] **Step 1: Update the existing single release note**

Add one plain-language bullet under `## 新增功能`:

```md
- Chat 中的 Codex 与 Claude Code 现在会在各自房间里延续上下文，应用重启后仍可继续；也可以随时为单个 Agent 开始新会话，而不清空房间历史。
```

- [ ] **Step 2: Run focused Team Chat verification**

```bash
npx vitest run \
  src/automation/engine/main/platform/configured-agent-execution-service.test.ts \
  src/main/team-chat/postgres-team-chat-store.test.ts \
  src/main/team-chat/pglite-team-chat-store.test.ts \
  src/main/team-chat/team-chat-routing.test.ts \
  src/main/team-chat/team-chat-service.test.ts \
  src/main/team-chat-ipc.test.ts \
  src/preload/team-chat.test.ts \
  src/renderer/src/team-chat-ui.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run full repository verification**

```bash
npm test
npm run build
npm run release-note:check
npm run package:smoke
```

Expected: every command exits 0. Package smoke must use its temporary HOME/npm prefix and clean its archive and child processes.

- [ ] **Step 4: Scan the changed content**

```bash
git diff --check
git diff --stat
git diff -- . ':!package-lock.json' | rg -n \
  'company\\.example|/home/developer/|postgres(?:ql)?://[^ ]+:[^ ]+@|api[_-]?key|secret'
```

Expected: no company identifiers, developer absolute paths, credentials, or connection secrets in product changes. Synthetic test URLs must use localhost/example domains and non-secret fixture text.

- [ ] **Step 5: Commit the completed feature**

```bash
git add .release-notes/feat-workflow-run-center-v1.md
git commit -m "docs(release): note persistent chat context"
```
