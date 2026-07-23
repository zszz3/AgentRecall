# PostgreSQL Multi-Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a single-user Raft-style Chat tab where existing configured Agents converse in persistent rooms backed by an automatically managed local PostgreSQL-compatible database, with optional external PostgreSQL support.

**Architecture:** `TeamChatService` in Electron main owns database selection, deterministic mention routing, and Agent execution. `PGliteTeamChatStore` is the default local store under Electron `userData`; `PostgresTeamChatStore` remains an optional external store using the same contract. Renderer accesses a narrow paginated API through preload and receives streaming deltas over an event channel; Team Chat data never enters the Automation full snapshot.

**Tech Stack:** Electron, TypeScript, React 19, Zod, PGlite, `pg`, Vitest, existing AgentHub Runtime adapters.

---

## File map

- `src/shared/team-chat.ts`: Renderer/main contract for connection status, rooms, members, messages, dispatches, and stream events.
- `src/shared/ipc/team-chat.ts`: Stable IPC channel names.
- `src/main/team-chat/team-chat-routing.ts`: Deterministic @mention parsing and bounded prompt construction.
- `src/main/team-chat/postgres-team-chat-store.ts`: PostgreSQL connection pool, schema migration, queries, and transaction boundaries.
- `src/main/team-chat/team-chat-service.ts`: Lazy connection lifecycle, root-turn scheduler, cancellation, Agent execution, and event emission.
- `src/main/ipc/team-chat.ts`: Zod validation and IPC delegation.
- `src/preload/team-chat.ts`: Typed renderer API and event subscription.
- `src/renderer/src/features/team-chat/team-chat-page.tsx`: Connection setup, room list, transcript, composer, member panel, and create-room dialog.
- `src/renderer/src/styles/team-chat.css`: Page-specific responsive layout.
- `src/main/services/automation-service.ts`: Own the Team Chat service and connect it to configured Agents.
- `src/main/index.ts`: Main-only persisted connection URL, IPC registration, and event forwarding.
- `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`: API exposure, primary navigation, page mount, and stylesheet import.
- `.release-notes/main-2-0.md`: One user-facing entry for the branch.

### Task 1: Shared contract and deterministic routing

**Files:**
- Create: `src/shared/team-chat.ts`
- Create: `src/shared/ipc/team-chat.ts`
- Create: `src/main/team-chat/team-chat-routing.ts`
- Test: `src/main/team-chat/team-chat-routing.test.ts`

- [x] **Step 1: Write failing routing tests**

Cover these observable cases:

```ts
expect(resolveTeamChatTargets("请 @Reviewer 检查", members, "human")).toEqual(["reviewer"]);
expect(resolveTeamChatTargets("一起看看", members, "human")).toEqual(["builder", "reviewer"]);
expect(resolveTeamChatTargets("完成了", members, "agent")).toEqual([]);
expect(resolveTeamChatTargets("交给 @Builder", members, "agent")).toEqual(["builder"]);
expect(resolveTeamChatTargets("@Ann 请看，@Anna 继续", overlappingMembers, "human"))
  .toEqual(["ann", "anna"]);
```

Also verify prompt history is chronological, bounded to 40 messages and 48,000 characters, and contains the remaining turn budget.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/main/team-chat/team-chat-routing.test.ts`

Expected: FAIL because `team-chat-routing.ts` and its exports do not exist.

- [x] **Step 3: Add the shared contract**

Define discriminated unions and request types with no Electron or PostgreSQL imports:

```ts
export type TeamChatConnectionState = "unconfigured" | "connecting" | "ready" | "error";
export type TeamChatSenderType = "human" | "agent" | "system";
export type TeamChatDispatchStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "skipped";
export type TeamChatMessageStatus = "final" | "error";

export interface TeamChatConnectionStatus {
  state: TeamChatConnectionState;
  databaseLabel?: string;
  error?: string;
}

export interface CreateTeamChatRoomRequest {
  name: string;
  workDir: string;
  agentIds: string[];
}

export interface SendTeamChatMessageRequest {
  roomId: string;
  content: string;
}
```

Include complete room/member/message/dispatch/page/event interfaces used by later tasks. Event variants must carry `roomId` and `rootMessageId`; streaming variants also carry `dispatchId`, `agentId`, and `content`.

- [x] **Step 4: Implement routing and prompt construction**

Use longest-display-name-first literal matching, escape regular-expression metacharacters, deduplicate in room order, and apply sender rules:

```ts
export function resolveTeamChatTargets(
  content: string,
  members: TeamChatRoomAgent[],
  senderType: "human" | "agent",
): string[] {
  const enabled = members.filter((member) => member.enabled);
  const mentioned = enabled.filter((member) => mentions(content, member.displayName));
  return mentioned.length > 0 ? mentioned.map((member) => member.agentId)
    : senderType === "human" ? enabled.map((member) => member.agentId) : [];
}
```

Build a structured prompt with room metadata, member names, transcript, triggering message, already-executed Agents, and `remainingExecutions`.

- [x] **Step 5: Run the focused test and verify GREEN**

Run: `npx vitest run src/main/team-chat/team-chat-routing.test.ts`

Expected: PASS.

### Task 2: PostgreSQL store

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/team-chat/postgres-team-chat-store.ts`
- Test: `src/main/team-chat/postgres-team-chat-store.test.ts`

- [x] **Step 1: Install PostgreSQL packages without lifecycle scripts**

Run:

```bash
npm install --ignore-scripts pg
npm install --ignore-scripts --save-dev @types/pg
```

Expected: `pg` is in dependencies, `@types/pg` is in devDependencies, and the repository postinstall does not touch the real user environment.

- [x] **Step 2: Write failing store tests with an injected PoolLike**

Use a fake pool/client, not a developer database. Verify:

- initialization acquires and releases the advisory lock;
- initialization marks stale `running` dispatches `interrupted`;
- room creation writes room and all member snapshots in one transaction;
- message pagination returns chronological rows and a `nextBefore` cursor;
- database failures are mapped without including the connection URL.

The test dependency surface is:

```ts
interface TeamChatPoolLike {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<TeamChatClientLike>;
  end(): Promise<void>;
}
```

- [x] **Step 3: Run the focused test and verify RED**

Run: `npx vitest run src/main/team-chat/postgres-team-chat-store.test.ts`

Expected: FAIL because `PostgresTeamChatStore` does not exist.

- [x] **Step 4: Implement schema initialization and row mapping**

Create schema `agent_recall` and tables `chat_rooms`, `chat_room_agents`, `chat_messages`, and `chat_dispatches`. Add indexes for room update order, message pagination, and root dispatch lookup. Use parameterized SQL for every value and an explicit transaction for room creation.

The public store methods are:

```ts
initialize(): Promise<void>;
close(): Promise<void>;
listRooms(): Promise<TeamChatRoomSummary[]>;
getRoom(roomId: string): Promise<TeamChatRoom | undefined>;
createRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
updateRoom(roomId: string, patch: UpdateTeamChatRoomRequest): Promise<TeamChatRoom>;
archiveRoom(roomId: string): Promise<void>;
listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage>;
insertMessage(message: TeamChatMessage): Promise<TeamChatMessage>;
insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch>;
updateDispatch(id: string, patch: TeamChatDispatchUpdate): Promise<void>;
markRunningDispatchesInterrupted(): Promise<void>;
```

- [x] **Step 5: Run the focused test and verify GREEN**

Run: `npx vitest run src/main/team-chat/postgres-team-chat-store.test.ts`

Expected: PASS with no external database access.

### Task 3: Bounded multi-Agent turn service

**Files:**
- Create: `src/main/team-chat/team-chat-service.ts`
- Test: `src/main/team-chat/team-chat-service.test.ts`
- Modify: `src/automation/engine/main/platform/configured-agent-execution-service.ts`
- Modify: `src/automation/engine/main/platform/configured-agent-execution-service.test.ts`

- [x] **Step 1: Write failing service tests**

Use an in-memory fake store and fake Agent executor. Verify:

1. sending a human message persists it before execution and returns immediately;
2. no mention runs all room Agents concurrently;
3. an explicit mention runs only the named Agent;
4. an Agent reply mentioning a new Agent schedules one next hop;
5. an Agent runs at most once per root turn;
6. execution stops after 8 total Agent dispatches and writes a system notice;
7. one failed Agent persists `failed` while siblings complete;
8. stop aborts active executors and marks dispatches interrupted;
9. events expose deltas but never a connection URL.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/main/team-chat/team-chat-service.test.ts src/automation/engine/main/platform/configured-agent-execution-service.test.ts`

Expected: new service tests fail; the existing executor test remains green.

- [x] **Step 3: Extend one-shot execution with events and cancellation**

Change the executor dependency and method without changing existing callers:

```ts
execute: (
  request: WorkflowAgentRequest,
  onEvent?: (event: WorkflowAgentEvent) => void,
  signal?: AbortSignal,
) => Promise<WorkflowAgentResponse>;

runOneShot(
  input: { configuredAgentId: string; prompt: string; workDir?: string },
  onEvent?: (event: WorkflowAgentEvent) => void,
  signal?: AbortSignal,
): Promise<{ output: string; durationMs: number }>;
```

Forward both optional arguments to `execute` and add a test that an aborted signal and delta callback reach the dependency.

- [x] **Step 4: Implement TeamChatService**

Use a lazy store factory and an `activeTurns` map of root message ID to `AbortController`. `sendMessage` validates room availability, persists the user message, emits `message-created`, then starts `runRootTurn` without awaiting it. The turn loop executes each hop with `Promise.allSettled`, persists final Agent messages, parses follow-up mentions, and filters the already-executed set before the next hop.

Connection methods must close the old store before switching URL, persist only a validated `postgres:` or `postgresql:` URL, and return a database label made from host/port/database without userinfo.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run: `npx vitest run src/main/team-chat/team-chat-service.test.ts src/automation/engine/main/platform/configured-agent-execution-service.test.ts`

Expected: PASS.

### Task 4: Service ownership, IPC, and preload

**Files:**
- Modify: `src/main/services/automation-service.ts`
- Create: `src/main/ipc/team-chat.ts`
- Create: `src/preload/team-chat.ts`
- Modify: `src/preload/index.ts`
- Test: `src/main/team-chat-ipc.test.ts`
- Test: `src/preload/team-chat.test.ts`
- Modify: `src/main/services/automation-service.test.ts`

- [x] **Step 1: Write failing IPC and preload tests**

Assert exact channel mappings for status/connect/disconnect, rooms list/create/update/archive, messages list/send, and stop turn. Validate rejection of:

- non-PostgreSQL URLs;
- names over 120 characters;
- messages over 100,000 characters;
- zero members or more than 24 members;
- list limits outside 1–100.

Verify `onEvent` returns a function that removes the same listener.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts src/main/services/automation-service.test.ts`

Expected: FAIL because Team Chat IPC and ownership do not exist.

- [x] **Step 3: Add IPC schemas and typed preload API**

Define `TEAM_CHAT_CHANNELS` and register all handlers through `registerTeamChatIpc`. Parse every unknown payload with Zod before delegation. Forward service events with `send(TEAM_CHAT_CHANNELS.event, event)` and never serialize errors directly.

Expose the API as `window.sessionSearch.teamChat`:

```ts
teamChat: {
  getConnectionStatus,
  connect,
  disconnect,
  listRooms,
  createRoom,
  updateRoom,
  archiveRoom,
  listMessages,
  sendMessage,
  stopTurn,
  onEvent,
}
```

- [x] **Step 4: Make NativeAutomationService own TeamChatService**

Add option callbacks `readTeamChatConnectionUrl` and `writeTeamChatConnectionUrl`. Build TeamChatService with snapshots from the existing Hub and the extended `ConfiguredAgentExecutionService`. Add `teamChat()` and close it before Hub shutdown. Start the selected Chat database asynchronously during application startup so it never blocks the rest of Automation initialization.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run: `npx vitest run src/main/team-chat-ipc.test.ts src/preload/team-chat.test.ts src/main/services/automation-service.test.ts`

Expected: PASS.

### Task 5: Main-process persistence and registration

**Files:**
- Modify: `src/main/index.ts`
- Test: `src/main/team-chat-wiring.test.ts`

- [x] **Step 1: Write a failing source-contract test**

Verify the main process creates a dedicated `electron-store` named `team-chat`, passes read/write callbacks into `NativeAutomationService`, registers Team Chat IPC, forwards events only to the current window, and disposes handlers during shutdown.

- [x] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/main/team-chat-wiring.test.ts`

Expected: FAIL because no Team Chat wiring exists.

- [x] **Step 3: Implement main wiring**

Persist `{ postgresUrl: string }` in the main process only. Register IPC beside Automation IPC after the service is constructed. Keep the URL out of `AppSettings`, Renderer snapshots, console output, and error messages. Dispose handlers and rely on `NativeAutomationService.shutdown()` to close the pool and abort turns.

- [x] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run src/main/team-chat-wiring.test.ts`

Expected: PASS.

### Task 6: Chat page and navigation

**Files:**
- Create: `src/renderer/src/features/team-chat/team-chat-page.tsx`
- Create: `src/renderer/src/styles/team-chat.css`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx`
- Modify: `src/renderer/src/workbench-ui.test.ts`
- Create: `src/renderer/src/team-chat-ui.test.ts`

- [x] **Step 1: Write failing UI contract tests**

Assert that the sidebar contains one `Chat` primary tab, `AppPage` includes `team-chat`, the tab mounts `TeamChatPage`, and the page source contains connection setup, create room, member selection, message pagination, send/stop controls, and event unsubscription.

- [x] **Step 2: Run the UI tests and verify RED**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/team-chat-ui.test.ts`

Expected: FAIL because the tab and page do not exist.

- [x] **Step 3: Build the connection and empty states**

On mount call `getConnectionStatus` and follow connection events while the managed local database starts. For error states show local retry plus an optional password-masked external PostgreSQL form. Clear the URL input immediately after a successful connection.

- [x] **Step 4: Build room and transcript interactions**

Load rooms after connection, select the first room, and fetch its newest messages. The create-room dialog reads configured Agents from `useAutomation()`, requires at least one checkbox, supports `pickDirectory`, and submits only Agent IDs. Render human, Agent, and system messages distinctly. Clicking a member inserts `@DisplayName` into the composer. Enter sends; Shift+Enter inserts a newline. The stop button is visible only for an active root turn.

- [x] **Step 5: Reconcile streaming events**

Maintain temporary messages keyed by `dispatchId`. Append delta events, remove the temporary entry when the persisted final message arrives, refresh room ordering after new messages, and ignore events for other rooms except room-summary refresh. Always unsubscribe in the effect cleanup.

- [x] **Step 6: Add compact responsive styling**

Use existing color, radius, typography, button, and focus tokens. Keep the room rail narrow, transcript dominant, and member rail compact. Under 980px collapse the member rail below the room header; under 720px show one pane at a time without horizontal overflow.

- [x] **Step 7: Run the UI tests and verify GREEN**

Run: `npx vitest run src/renderer/src/workbench-ui.test.ts src/renderer/src/team-chat-ui.test.ts`

Expected: PASS while preserving the existing Session rename and index-refresh button assertions.

### Task 7: Release note and full verification

**Files:**
- Modify: `.release-notes/main-2-0.md`

- [x] **Step 1: Update the branch's single release note**

Add one plain-language bullet under `## 新增功能` explaining that users can create persistent multi-Agent Chat rooms with automatic local storage, optionally use external PostgreSQL, choose existing Agents, and route messages with @mentions. Do not mention table names, IPC, branch names, migrations, or implementation details.

- [x] **Step 2: Run focused Team Chat tests**

Run:

```bash
npx vitest run \
  src/main/team-chat/team-chat-routing.test.ts \
  src/main/team-chat/postgres-team-chat-store.test.ts \
  src/main/team-chat/team-chat-service.test.ts \
  src/main/team-chat-ipc.test.ts \
  src/main/team-chat-wiring.test.ts \
  src/preload/team-chat.test.ts \
  src/renderer/src/team-chat-ui.test.ts \
  src/renderer/src/workbench-ui.test.ts
```

Expected: PASS.

- [x] **Step 3: Run typecheck and the complete Vitest suite**

Run:

```bash
npm run typecheck
npx vitest run
```

Expected: PASS.

- [x] **Step 4: Build the application**

Run: `npm run build`

Expected: Electron main, preload, renderer, and MCP bundle build successfully.

- [x] **Step 5: Validate the release note**

Run: `npm run release-note:check`

Expected: PASS with exactly the existing `main-2-0.md` branch note updated.

- [x] **Step 6: Inspect the final diff for sensitive information**

Run:

```bash
git diff --check
git diff --stat
rg -n -i "corp\.|internal\.|postgres(?:ql)?://[^[:space:]]+:[^[:space:]@]+@" \
  src docs .release-notes package.json
```

Expected: no whitespace errors, no real credentials, hosts, private organization names, or personal absolute paths in product code and documentation. References in synthetic tests must use neutral values such as `postgresql://user:secret@localhost/agent_recall_test`.

The user requested direct inline execution in the current branch, so implementation proceeds immediately without another approval checkpoint or automatic commit.

### Task 8: Automatically managed local PostgreSQL-compatible database

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/team-chat/pglite-team-chat-store.ts`
- Test: `src/main/team-chat/pglite-team-chat-store.test.ts`
- Modify: `src/shared/team-chat.ts`
- Modify: `src/shared/ipc/team-chat.ts`
- Modify: `src/main/team-chat/team-chat-service.ts`
- Modify: `src/main/team-chat/team-chat-service.test.ts`
- Modify: `src/main/ipc/team-chat.ts`
- Modify: `src/preload/team-chat.ts`
- Modify: `src/main/services/automation-service.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/features/team-chat/team-chat-page.tsx`
- Modify: `src/renderer/src/styles/team-chat.css`
- Modify: `.release-notes/main-2-0.md`

- [x] **Step 1: Write failing tests for local persistence and automatic selection**

  Verify a temporary PGlite data directory survives close/reopen, an empty saved URL selects local mode, concurrent `connect()` calls share one initialization, switching from external to local closes the external store, IPC never accepts a local path, and the UI keeps external PostgreSQL behind an explicit control.

- [x] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  npx vitest run src/main/team-chat/pglite-team-chat-store.test.ts src/main/team-chat/team-chat-service.test.ts src/main/team-chat-ipc.test.ts src/main/team-chat-wiring.test.ts src/preload/team-chat.test.ts src/renderer/src/team-chat-ui.test.ts
  ```

  Expected: FAIL because `PGliteTeamChatStore`, local connection mode, and the local IPC method are missing.

- [x] **Step 3: Implement the PGlite store and shared connection mode**

  Add `@electric-sql/pglite`, adapt its single-connection query API to the existing `TeamChatStore` contract, initialize the same schema without advisory locks, and expose `mode: "local" | "external"` in ready/connecting/error statuses.

- [x] **Step 4: Start local storage automatically and serialize database switching**

  Give `TeamChatService` a main-process-only `localStoreFactory`. When no saved external URL exists, `connect()` initializes it once; `useLocalDatabase()` clears the saved external URL, stops active turns, closes the previous store, and opens local storage.

- [x] **Step 5: Wire the local path and retain external PostgreSQL as an advanced option**

  Pass `path.join(app.getPath("userData"), "team-chat-pgdata")` from main. Add a parameterless local IPC method and preload API. In Chat, connect automatically on mount, label local mode clearly, and reveal the password-masked external URL form only when requested.

- [x] **Step 6: Verify focused tests, full tests, typecheck, build, release note, package installation, and sensitive-data scan**

  Run the focused command from Step 2, then `npm run typecheck`, `npm test`, `npm run build`, `npm run release-note:check`, `npm run package:smoke`, `git diff --check`, and the existing sensitive-data `rg` scan. Package or install tests use a temporary HOME/prefix, initialize the packaged local database once, and remove all temporary files and child processes afterward.
