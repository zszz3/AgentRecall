# Evaluation Native Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete native Evaluation workspace to AgentRecall using its existing Runtime agents and Automation storage.

**Architecture:** Import the Evaluation domain and focused tests from the frozen Multi Agent Chat `ef81808` snapshot under `src/automation/engine/`. Wrap it with an AgentRecall-owned `EvaluationService`, validated `automation:evaluation:*` IPC, typed preload methods, and an embedded first-class page. Evaluation shares `automation.db` and executes fresh one-shot requests through the existing AgentHub.

**Tech Stack:** Electron 42, TypeScript, React 19, Vitest, Zod 4, Node 22 SQLite, existing AgentHub Runtime adapters.

---

## File map

- `src/automation/engine/main/evaluation-store.ts`: SQLite CRUD and nested result persistence.
- `src/automation/engine/main/evaluation/schema.ts`: Evaluation-only tables and indexes.
- `src/automation/engine/main/evaluation-runner.ts`: deterministic evaluators, LLM Judge, repetitions, and aggregation.
- `src/automation/engine/main/platform/configured-agent-execution-service.ts`: resolve an Agent profile and make a fresh one-shot AgentHub request.
- `src/automation/engine/shared/evaluation-templates.ts`: dataset and evaluator templates.
- `src/automation/engine/shared/evaluation/evaluator-prompts.ts`: editable Judge rubrics.
- `src/automation/engine/renderer/src/pages/evaluation/`: four Evaluation workspaces and controller hook.
- `src/main/services/evaluation-service.ts`: AgentRecall orchestration boundary for CRUD and experiment execution.
- `src/main/services/automation-service.ts`: owns and closes the Evaluation service.
- `src/shared/ipc/automation.ts`, `src/main/ipc/automation.ts`, `src/preload/automation.ts`: typed and validated renderer bridge.
- `src/renderer/src/features/automation/evaluation-feature-page.tsx`: AgentRecall page adapter.
- `src/renderer/src/App.tsx`: `Eval` navigation and page mount.
- `src/renderer/src/styles/automation.css`: scoped host layout fixes only; upstream Evaluation styles are already bundled.
- `src/automation/upstream-manifest.json`: imported Eval file provenance.
- `.release-notes/main-2-0.md`: one user-facing Evaluation bullet.

### Task 1: Import and verify Evaluation domain behavior

**Files:**
- Create: `src/automation/engine/main/evaluation-store.test.ts`
- Create: `src/automation/engine/main/evaluation-runner.test.ts`
- Create: `src/automation/engine/shared/evaluation-templates.test.ts`
- Create: `src/automation/engine/renderer/src/pages/evaluation/evaluator-factory.test.ts`
- Create: matching production files listed in the file map

- [ ] **Step 1: Copy the focused tests from commit `ef81808` before production files**

The store test must create its database beneath `mkdtemp(join(tmpdir(), "agent-recall-evaluation-"))`; runner tests use fake functions such as:

```ts
const execute = vi.fn(async (_agentId: string, prompt: string) => ({
  output: `answer:${prompt}`,
  durationMs: 12,
}));
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run src/automation/engine/main/evaluation-store.test.ts src/automation/engine/main/evaluation-runner.test.ts src/automation/engine/shared/evaluation-templates.test.ts src/automation/engine/renderer/src/pages/evaluation/evaluator-factory.test.ts
```

Expected: FAIL because the Evaluation production modules have not been imported.

- [ ] **Step 3: Import production files from the frozen commit**

Preserve paths relative to upstream `src/` beneath `src/automation/engine/`. Keep the existing target `shared/evaluation/types.ts`; import schema, store, runner, templates, prompts, configured Agent executor, and renderer files. Do not read files from the dirty source working tree.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Expected: all imported Evaluation tests pass without reading the real HOME or launching an Agent process.

### Task 2: Add the AgentRecall Evaluation service

**Files:**
- Create: `src/main/services/evaluation-service.test.ts`
- Create: `src/main/services/evaluation-service.ts`
- Modify: `src/main/services/automation-service.test.ts`
- Modify: `src/main/services/automation-service.ts`

- [ ] **Step 1: Write failing service tests**

Use injected store and executor fakes and assert:

```ts
await service.runExperiment("experiment-1");
expect(executeAgent).toHaveBeenCalledWith("target-agent", "case input");
expect(saveRun).toHaveBeenCalledWith(expect.objectContaining({
  experimentId: "experiment-1",
  agentRevisionId: "revision-2",
}));
```

Also assert a Judge Channel resolves to an execution Agent and missing datasets/agents/channels produce explicit errors.

- [ ] **Step 2: Run the test and verify RED**

Run `npx vitest run src/main/services/evaluation-service.test.ts`; expect module-not-found.

- [ ] **Step 3: Implement `EvaluationService`**

Expose typed CRUD methods plus:

```ts
runExperiment(experimentId: string): Promise<EvaluationRun>
close(): void
```

Construct `ConfiguredAgentExecutionService` with `hub.snapshot().configuredAgents`, `hub.snapshot().channels`, `hub.getWorkDir()`, and `hub.askWorkflowAgent(request)`.

- [ ] **Step 4: Attach it to `NativeAutomationService`**

Add `evaluations(): EvaluationService`, construct it against `paths.databasePath`, and close it during shutdown after active Hub work stops and before reporting the service stopped.

- [ ] **Step 5: Run service tests and verify GREEN**

Run both Evaluation and Automation lifecycle service suites.

### Task 3: Add validated IPC and preload methods

**Files:**
- Modify: `src/main/automation-ipc.test.ts`
- Modify: `src/preload/automation.test.ts`
- Modify: `src/shared/ipc/automation.ts`
- Modify: `src/main/ipc/automation.ts`
- Modify: `src/preload/automation.ts`

- [ ] **Step 1: Add failing IPC and preload tests**

Assert all Evaluation handlers are `automation:` prefixed, save delegates validated values, repetitions outside 1–5 fail, oversized Case input fails, and preload maps list/save/delete/run calls to their exact constants.

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
npx vitest run src/main/automation-ipc.test.ts src/preload/automation.test.ts
```

Expected: missing channel constants and API methods.

- [ ] **Step 3: Define contracts and validation**

Add constants for dataset/evaluator/experiment/run operations. Validate IDs, names, descriptions, Case arrays, evaluator threshold, prompt, Channel ID, evaluator ID arrays and integer repetitions. The run handler accepts only:

```ts
z.object({ experimentId: idSchema }).strict()
```

- [ ] **Step 4: Implement handlers and preload API**

Handlers call `service.evaluations()` after `requireReady()`. Preload exposes `listEvaluationDatasets`, `saveEvaluationDataset`, `deleteEvaluationDataset`, the equivalent evaluator/experiment methods, `listEvaluationRuns`, `deleteEvaluationRun`, and `runEvaluationExperiment`.

- [ ] **Step 5: Run tests and verify GREEN**

Run IPC, preload, Evaluation service and imported domain tests together.

### Task 4: Embed the Evaluation page

**Files:**
- Create: `src/renderer/src/features/automation/evaluation-feature-page.tsx`
- Modify: `src/automation/engine/renderer/src/pages/evaluation/EvaluationPage.tsx`
- Modify: `src/automation/engine/renderer/src/pages/evaluation/useEvaluationWorkbench.ts`
- Modify: `src/renderer/src/automation-ui.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/automation.css`

- [ ] **Step 1: Add a failing UI contract test**

Assert `App.tsx` contains `data-page="evaluation"`, `<EvaluationFeaturePage`, and the Automation page adapter passes current `configuredAgents` and `channels`.

- [ ] **Step 2: Run the UI test and verify RED**

Run `npx vitest run src/renderer/src/automation-ui.test.ts`; expect missing Eval navigation/page.

- [ ] **Step 3: Remove the source app global from the Evaluation controller**

Define an `EvaluationApi` interface in `useEvaluationWorkbench.ts`, accept it as an argument, and replace each `window.multiAgentChat.*` call with `api.*`. Pass the API through `EvaluationPage` so the imported page remains renderer-shell independent.

- [ ] **Step 4: Add the AgentRecall adapter and navigation**

The adapter renders:

```tsx
<AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
  <EvaluationPage language={language} agents={snapshot.configuredAgents} channels={snapshot.channels} api={api} />
</AutomationPageState>
```

Add `evaluation` to `AppPage`, add a Beaker navigation button after Workflow, and mount the adapter. Scope any host sizing rules beneath `.automation-evaluation-page`.

- [ ] **Step 5: Run the UI test and verify GREEN**

Also run `npm run typecheck` to catch renderer/preload contract drift.

### Task 5: Record provenance, release copy, and verify the product

**Files:**
- Modify: `src/automation/upstream-manifest.json`
- Modify: `.release-notes/main-2-0.md`

- [ ] **Step 1: Append every imported source/test file and SHA-256 to the manifest**

Use commit `ef81808a8e0258bb157cc98d3aadd8be837b3540`; do not include target-owned adapters.

- [ ] **Step 2: Update the existing branch release note**

Add one plain-language `新增功能` bullet describing datasets, deterministic/LLM evaluators, repeatable experiments, Case results and history. Do not add a second release-note file.

- [ ] **Step 3: Run focused and full verification**

With the development Electron process stopped, run:

```bash
npx vitest run src/automation/engine/main/evaluation-store.test.ts src/automation/engine/main/evaluation-runner.test.ts src/automation/engine/shared/evaluation-templates.test.ts src/main/services/evaluation-service.test.ts src/main/automation-ipc.test.ts src/preload/automation.test.ts src/renderer/src/automation-ui.test.ts
npm run typecheck
npm run test
npm run build
npm run release-note:check
```

Expected: all commands pass, and no test accesses the real user configuration or session data.

- [ ] **Step 4: Scan for sensitive and stale product information**

Search changed files for company hosts, private package names, credentials, `/Users/` literals, source app globals, and runtime `MULTI_AGENT_CHAT` markers. The only allowed source name is manifest/design provenance.

- [ ] **Step 5: Start the development app for inspection**

Run `npm run dev` only after verification. Keep the returned process session available for the user and report its state; do not commit or push unless explicitly requested.
