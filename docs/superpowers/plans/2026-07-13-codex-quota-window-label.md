# Codex Quota Window Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly display the current Codex seven-day primary quota while retaining compatibility with legacy five-hour and seven-day responses.

**Architecture:** Keep the request and renderer unchanged. Add a small duration-aware mapping in the Codex response parser so each rate-limit window selects its existing stable key and label from `limit_window_seconds`, with the previous primary/secondary position mapping as a fallback when duration is absent.

**Tech Stack:** TypeScript, Vitest, Electron/Vite

## Global Constraints

- `18000` seconds maps to `five_hour` / `5h`.
- `604800` seconds maps to `seven_day` / `7d`.
- Missing or unknown durations preserve the legacy primary 5h and secondary 7d mapping.
- Codex request/authentication, Claude quota parsing, code-review quota, and renderer behavior remain unchanged.

---

### Task 1: Detect Codex quota windows from duration

**Files:**
- Modify: `src/core/quota.ts`
- Test: `src/core/quota.test.ts`

**Interfaces:**
- Consumes: `CodexUsageWindow.limit_window_seconds?: number` and the existing `quotaFromUsedPercent(...)` normalizer.
- Produces: duration-aware `UsageQuota` entries from `codexQuotasFromResponse(response, now)`; no public API changes.

- [ ] **Step 1: Write the failing regression test**

Add a test after the existing Codex normalization test:

```ts
it("labels a seven-day Codex primary window from its duration", async () => {
  const homeDir = makeHome();
  try {
    writeJson(path.join(homeDir, ".codex", "auth.json"), {
      tokens: { access_token: "codex-access", account_id: "account-1" },
    });

    const card = await loadCodexQuotaCard({
      now: NOW,
      homeDir,
      env: {},
      codexFetcher: async () => ({
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 604800,
            reset_at: 1_807_000_000,
          },
          secondary_window: null,
        },
      }),
    });

    expect(card.quotas).toEqual([
      expect.objectContaining({ key: "seven_day", label: "7d", usedPercent: 20, remainingPercent: 80 }),
    ]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npm test -- --run src/core/quota.test.ts -t "labels a seven-day Codex primary window from its duration"`

Expected: FAIL because the actual quota still has `key: "five_hour"` and `label: "5h"`.

- [ ] **Step 3: Implement the minimal duration-aware mapping**

Add duration constants and a helper near the existing Codex quota constants/functions:

```ts
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

function codexWindowIdentity(
  window: CodexUsageWindow,
  fallback: { key: string; label: string },
): { key: string; label: string } {
  if (window.limit_window_seconds === FIVE_HOURS_SECONDS) return { key: QUOTA_FIVE_HOUR, label: "5h" };
  if (window.limit_window_seconds === SEVEN_DAYS_SECONDS) return { key: QUOTA_SEVEN_DAY, label: "7d" };
  return fallback;
}
```

Update `codexQuotasFromResponse(...)` so primary and secondary each call the helper before `quotaFromUsedPercent(...)`:

```ts
if (primary) {
  const identity = codexWindowIdentity(primary, { key: QUOTA_FIVE_HOUR, label: "5h" });
  quotas.push(quotaFromUsedPercent(identity.key, identity.label, codexWindowUsedPercent(primary), codexWindowResetAt(primary, now), now));
}
if (secondary) {
  const identity = codexWindowIdentity(secondary, { key: QUOTA_SEVEN_DAY, label: "7d" });
  quotas.push(quotaFromUsedPercent(identity.key, identity.label, codexWindowUsedPercent(secondary), codexWindowResetAt(secondary, now), now));
}
```

- [ ] **Step 4: Verify GREEN and compatibility**

Run: `npm test -- --run src/core/quota.test.ts`

Expected: all quota tests pass, including the new seven-day primary regression and the legacy two-window tests.

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

Run: `npm test -- --run`

Expected: all repository tests pass. If the sandbox reports `listen EPERM 127.0.0.1`, rerun the same command with host permissions before classifying it as a regression.

- [ ] **Step 5: Commit the fix**

```bash
git add src/core/quota.ts src/core/quota.test.ts docs/superpowers/plans/2026-07-13-codex-quota-window-label.md
git commit -m "fix: detect Codex quota window duration"
```
