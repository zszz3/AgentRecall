# Runtime Provider Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make V2 Runtime discover models from the selected Provider, including Claude Code + DeepSeek, through an explicit and observable “探测模型” action.

**Architecture:** Add optional model-catalog metadata to Provider presets and resolve discovery from the selected preset before applying the existing OpenAI-compatible fallback. Keep catalog fetching and merge/persistence in the existing model-catalog and AgentHub boundaries. Surface request progress in `RuntimePage` and derive the success label from the refreshed channel.

**Tech Stack:** Electron, React, TypeScript, Vitest, existing AgentHub IPC

---

### Task 1: Resolve model catalogs from the selected Provider

**Files:**
- Modify: `apps/main-2.0/src/automation/engine/shared/provider-presets.ts`
- Modify: `apps/main-2.0/src/automation/engine/main/channels/model-catalog.ts`
- Create: `apps/main-2.0/src/automation/engine/main/channels/model-catalog.test.ts`

- [ ] **Step 1: Write the failing Provider discovery tests**

Add tests that pass a fake `fetchImpl` and assert the requested URL:

```ts
test("discovers DeepSeek models for a Claude Code channel from the Provider catalog URL", async () => {
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 });
  };
  const result = await discoverChannelModels({
    id: "claude-deepseek",
    agentId: "claude",
    label: "Claude Code + DeepSeek",
    presetId: "claude-code-deepseek",
    providerName: "DeepSeek",
    modelProvider: "deepseek-anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiFormat: "anthropic",
    httpHeaders: { Authorization: "Bearer secret" },
    models: [{ id: "default", label: "Default" }],
  }, { fetchImpl });

  expect(requests).toEqual(["https://api.deepseek.com/models"]);
  expect(result.models).toEqual([{ id: "deepseek-chat", label: "deepseek-chat" }]);
});
```

Add these three concrete assertions in the same test after the DeepSeek assertions:

```ts
await expect(discoverChannelModels({
  id: "claude-openrouter",
  agentId: "claude",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiFormat: "openai_chat",
  models: [],
}, { fetchImpl })).resolves.toMatchObject({ source: "openai_models" });
expect(requests.at(-1)).toBe("https://openrouter.ai/api/v1/models");

await expect(discoverChannelModels({
  id: "custom",
  agentId: "api",
  label: "Custom",
  baseUrl: "https://models.example.test/v1/",
  models: [],
}, { fetchImpl })).resolves.toMatchObject({ source: "openai_models" });
expect(requests.at(-1)).toBe("https://models.example.test/v1/models");

await expect(discoverChannelModels({
  id: "claude-local-default",
  agentId: "claude",
  label: "Claude Code",
  baseUrl: "https://api.anthropic.com",
  models: [],
}, { fetchImpl })).rejects.toBeInstanceOf(ModelCatalogUnsupportedError);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `apps/main-2.0`:

```bash
npx vitest run src/automation/engine/main/channels/model-catalog.test.ts
```

Expected: the DeepSeek case fails with `ModelCatalogUnsupportedError` because the current implementation rejects every Claude channel.

- [ ] **Step 3: Add Provider catalog metadata and resolver logic**

Extend `AgentProviderPreset` and enrich the generated DeepSeek preset without editing the generated source:

```ts
export interface AgentProviderPreset {
  id: string;
  label: string;
  runtimeAgentId: AgentId;
  providerName?: string;
  modelProvider?: string;
  baseUrl?: string;
  modelCatalogUrl?: string;
  wireApi?: string;
  apiFormat?: RuntimeProviderApiFormat;
  apiKeyField?: ClaudeApiKeyField;
  modelReasoningEffort?: string;
  models: AgentModelOption[];
  usesApiKey?: boolean;
  apiKeyHeaderName?: string;
  apiKeyPrefix?: string;
  extraHeaders?: Record<string, string>;
  configurableModelId?: boolean;
  configurableModelLabel?: string;
  configurableModelPlaceholder?: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
  category?: string;
  environment?: Record<string, string>;
  requiresOAuth?: boolean;
  providerType?: string;
}

const PROVIDER_MODEL_CATALOG_URLS: Readonly<Record<string, string>> = {
  "claude-code-deepseek": "https://api.deepseek.com/models",
};

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  ...CC_SWITCH_PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    ...(PROVIDER_MODEL_CATALOG_URLS[preset.id]
      ? { modelCatalogUrl: PROVIDER_MODEL_CATALOG_URLS[preset.id] }
      : {}),
  })),
  {
    id: CODEX_LOCAL_DEFAULT_PRESET_ID,
    label: "Default",
    runtimeAgentId: "codex",
    category: "local",
    usesApiKey: true,
    models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
  },
  {
    id: CLAUDE_LOCAL_DEFAULT_PRESET_ID,
    label: "Default",
    runtimeAgentId: "claude",
    category: "local",
    apiFormat: "anthropic",
    usesApiKey: true,
    models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
  },
  {
    id: "custom",
    label: "Custom",
    runtimeAgentId: "codex",
    providerName: "Custom",
    modelProvider: "custom",
    wireApi: "responses",
    apiFormat: "openai_responses",
    usesApiKey: true,
    models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
  },
  {
    id: "claude-code-custom",
    label: "Custom",
    runtimeAgentId: "claude",
    providerName: "Custom",
    modelProvider: "custom-anthropic",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    usesApiKey: true,
    models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
  },
  ...LEGACY_PROVIDER_PRESETS.filter(
    (preset) => preset.runtimeAgentId !== "codex" && preset.runtimeAgentId !== "claude",
  ),
];
```

In `model-catalog.ts`, find the preset by `presetId`, then by runtime/model-provider identity for migrated channels. Use `modelCatalogUrl` first. Otherwise derive `/models` only for OpenAI-compatible channels; treat Claude channels without an explicit OpenAI API format as unsupported. Keep official Codex CLI discovery as the first branch.

```ts
function providerPresetForChannel(channel: AgentChannel): AgentProviderPreset | undefined {
  return AGENT_PROVIDER_PRESETS.find((preset) =>
    preset.runtimeAgentId === channel.agentId && (
      preset.id === channel.presetId ||
      Boolean(channel.modelProvider && preset.modelProvider === channel.modelProvider)
    ));
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/automation/engine/main/channels/model-catalog.test.ts
```

Expected: all Provider discovery tests pass, and the captured DeepSeek URL is exactly `https://api.deepseek.com/models`.

- [ ] **Step 5: Commit the Provider resolver**

```bash
git add apps/main-2.0/src/automation/engine/shared/provider-presets.ts apps/main-2.0/src/automation/engine/main/channels/model-catalog.ts apps/main-2.0/src/automation/engine/main/channels/model-catalog.test.ts
git commit -m "feat: discover runtime models from selected provider"
```

### Task 2: Expose an explicit Runtime discovery action

**Files:**
- Modify: `apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/RuntimePage.tsx`
- Modify: `apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager.ts`
- Create: `apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.tsx`

- [ ] **Step 1: Write the failing Runtime UI test**

Render `RuntimePage` in `happy-dom` with one DeepSeek channel. Assert a visible `探测模型` button exists. Return a deferred Promise from `onRefreshModels`, click the button, and assert it becomes disabled until the Promise settles.

```tsx
const button = [...container.querySelectorAll("button")]
  .find((item) => item.textContent?.includes("探测模型"));
expect(button).toBeDefined();
await act(async () => button!.click());
expect(button!.disabled).toBe(true);
```

- [ ] **Step 2: Run the Runtime UI test and verify RED**

Run:

```bash
npx vitest run src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.tsx
```

Expected: no visible `探测模型` button exists because the current action is icon-only.

- [ ] **Step 3: Implement the visible button and busy state**

Change the bilingual label to `探测模型` / `Detect models`. Track the refreshing channel inside `RuntimePage`, await the existing callback, and always clear the busy state:

```tsx
const [refreshingModelChannelId, setRefreshingModelChannelId] = useState<string>();

const detectModels = async (channelId: string): Promise<void> => {
  if (!onRefreshModels || refreshingModelChannelId) return;
  setRefreshingModelChannelId(channelId);
  try {
    await onRefreshModels(channelId);
  } finally {
    setRefreshingModelChannelId(undefined);
  }
};
```

Render it as `control-btn compact secondary` with the refresh icon and text, disabled while the selected channel is refreshing. Keep “添加模型” beside it.

Update `useRuntimeConfigManager.refreshModelCatalog` so successful status identifies the selected Provider from the returned snapshot:

```ts
const refreshedChannel = result.snapshot.channels.find((channel) => channel.id === channelId);
const sourceLabel = result.source === "codex_cli"
  ? "Codex CLI"
  : refreshedChannel?.providerName || refreshedChannel?.modelProvider || "Provider API";
setConfigStatus(`Loaded ${result.discoveredCount} models from ${sourceLabel}`);
```

- [ ] **Step 4: Run the UI and hook tests and verify GREEN**

Run:

```bash
npx vitest run src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.tsx src/automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager.test.ts
```

Expected: the button visibility/busy-state tests and existing hook tests pass.

- [ ] **Step 5: Commit the Runtime UI**

```bash
git add apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/RuntimePage.tsx apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager.ts apps/main-2.0/src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.tsx
git commit -m "feat: expose runtime model discovery"
```

### Task 3: Release note and verification

**Files:**
- Create: `.release-notes/runtime-provider-model-discovery.md`

- [ ] **Step 1: Add the single user-facing release note**

```md
# Runtime 模型探测

## Bug 修复

- Runtime 现在会根据当前 Provider 探测可用模型；Claude Code 搭配 DeepSeek 等服务时，不再因执行器类型而无法刷新模型目录。
```

- [ ] **Step 2: Run focused verification**

Run from `apps/main-2.0`:

```bash
npx vitest run src/automation/engine/main/channels/model-catalog.test.ts src/automation/engine/main/hub/agent-hub.test.ts src/automation/engine/renderer/src/pages/runtime/RuntimePage.test.tsx src/automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript reports no errors.

- [ ] **Step 3: Validate release notes and diff hygiene**

Run from the repository root:

```bash
npm run release-note:check
git diff --check
git status --short
```

Expected: the release-note check and diff check pass; the pre-existing untracked `specs/` files remain untouched.

- [ ] **Step 4: Commit the release note and final adjustments**

```bash
git add .release-notes/runtime-provider-model-discovery.md
git commit -m "docs: note provider-aware model discovery"
```
