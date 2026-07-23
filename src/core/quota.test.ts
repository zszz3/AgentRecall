import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadClaudeQuotaCard, loadCodexQuotaCard, loadUsageQuotaSnapshot } from "./quota";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "session-search-quota-"));
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), "utf8");
}

describe("usage quota loader", () => {
  it("loads Codex subscription quota from OAuth auth and normalizes remaining percentages", async () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".codex", "auth.json"), {
        tokens: {
          access_token: "codex-access",
          account_id: "account-1",
        },
      });

      const card = await loadCodexQuotaCard({
        now: NOW,
        homeDir,
        env: {},
        codexFetcher: async (accessToken, accountId) => {
          expect(accessToken).toBe("codex-access");
          expect(accountId).toBe("account-1");
          return {
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 25, reset_at: 1_807_000_000 },
              secondary_window: { used_percent: 60, reset_at: 1_807_400_000 },
            },
          };
        },
      });

      expect(card).toMatchObject({
        provider: "codex",
        displayName: "Codex",
        status: "supported",
        source: "chatgpt.com",
        plan: "Plus",
      });
      expect(card.quotas).toEqual([
        expect.objectContaining({ key: "five_hour", label: "5h", usedPercent: 25, remainingPercent: 75 }),
        expect.objectContaining({ key: "seven_day", label: "7d", usedPercent: 60, remainingPercent: 40 }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

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

  it("parses Codex quota from percent_left when used_percent is absent", async () => {
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
          plan_type: "pro",
          rate_limit: {
            primary_window: { percent_left: 65, reset_at: 1_807_000_000 },
            secondary_window: { percent_left: 40, reset_at: 1_807_400_000 },
          },
        }),
      });

      expect(card.status).toBe("supported");
      expect(card.plan).toBe("Pro");
      // percent_left=65 → usedPercent=35, remainingPercent=65
      expect(card.quotas).toEqual([
        expect.objectContaining({ key: "five_hour", usedPercent: 35, remainingPercent: 65 }),
        expect.objectContaining({ key: "seven_day", usedPercent: 60, remainingPercent: 40 }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("parses Codex quota from remaining_percent when used_percent is absent", async () => {
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
            primary_window: { remaining_percent: 80, reset_at: 1_807_000_000 },
          },
        }),
      });

      expect(card.status).toBe("supported");
      // remaining_percent=80 → usedPercent=20, remainingPercent=80
      expect(card.quotas).toEqual([
        expect.objectContaining({ key: "five_hour", usedPercent: 20, remainingPercent: 80 }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("computes Codex reset time from reset_after_seconds when reset_at is absent", async () => {
    const homeDir = makeHome();
    const now = new Date("2026-06-01T12:00:00.000Z");
    try {
      writeJson(path.join(homeDir, ".codex", "auth.json"), {
        tokens: { access_token: "codex-access", account_id: "account-1" },
      });

      const card = await loadCodexQuotaCard({
        now,
        homeDir,
        env: {},
        codexFetcher: async () => ({
          rate_limit: {
            primary_window: { used_percent: 50, reset_after_seconds: 3600 },
          },
        }),
      });

      expect(card.status).toBe("supported");
      expect(card.quotas[0].resetsAt).toBe("2026-06-01T13:00:00.000Z");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("loads Claude Code quota from a local statusline snapshot", () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
        plan: "max",
        source: "onwatch",
        rate_limits: {
          five_hour: { used_percentage: 10, resets_at: 1_807_000_000 },
          seven_day: { remaining_percentage: 55, resets_at: 1_807_400_000 },
        },
      });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });

      expect(card).toMatchObject({
        provider: "claude-code",
        displayName: "Claude Code",
        status: "supported",
        source: "onwatch",
        plan: "Max",
      });
      expect(card.quotas).toEqual([
        expect.objectContaining({ key: "five_hour", label: "5h", usedPercent: 10, remainingPercent: 90 }),
        expect.objectContaining({ key: "seven_day", label: "7d", usedPercent: 45, remainingPercent: 55 }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("parses Claude Code quota from quotas format with used_percentage field name", () => {
    const homeDir = makeHome();
    try {
      // Some tools (onwatch/kaboo) write used_percentage instead of used_percent
      writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
        source: "onwatch",
        plan: "pro",
        quotas: {
          five_hour: { label: "5h", used_percentage: 30, resets_at: "2027-04-05T13:00:00.000Z" },
        },
      });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });

      expect(card.status).toBe("supported");
      expect(card.plan).toBe("Pro");
      expect(card.quotas).toEqual([
        expect.objectContaining({ key: "five_hour", label: "5h", usedPercent: 30, remainingPercent: 70 }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("repairs a missing Claude Code statusLine when loading a stale local snapshot", () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".claude", "settings.json"), { env: {} });
      writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
        source: "agent-recall-statusline",
        updated_at: "2026-05-31T12:00:00.000Z",
        rate_limits: {
          five_hour: { used_percentage: 10, resets_at: 1_807_000_000 },
        },
      });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });

      expect(card.status).toBe("supported");
      const settings = JSON.parse(readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8")) as {
        statusLine?: { command?: string };
      };
      expect(settings.statusLine?.command).toContain("claude-statusline-snapshot.cjs");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing Claude Code statusLine that already points to our bridge", () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".claude", "settings.json"), {
        statusLine: { type: "command", command: "agent-recall-claude-statusline" },
      });
      writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
        source: "agent-recall-statusline",
        updated_at: "2026-05-31T12:00:00.000Z",
        rate_limits: {
          five_hour: { used_percentage: 10, resets_at: 1_807_000_000 },
        },
      });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: { PATH: "/usr/bin:/bin" } });

      expect(card.status).toBe("supported");
      const settings = JSON.parse(readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8")) as {
        statusLine?: { command?: string; type?: string };
      };
      // Should NOT overwrite the existing command—even if the resolved path differs.
      expect(settings.statusLine?.command).toBe("agent-recall-claude-statusline");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("installs the Claude Code statusLine when no quota snapshot exists yet", () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".claude", "settings.json"), { env: {} });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });

      expect(card.status).toBe("not_configured");
      expect(card.detail).toContain("Restart Claude Code");
      const settings = JSON.parse(readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8")) as {
        statusLine?: { command?: string };
      };
      expect(settings.statusLine?.command).toContain("claude-statusline-snapshot.cjs");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns a snapshot for both providers", async () => {
    const homeDir = makeHome();
    try {
      const snapshot = await loadUsageQuotaSnapshot({
        now: NOW,
        homeDir,
        env: {},
        codexFetcher: async () => ({}),
      });

      expect(snapshot.generatedAt).toBe(NOW.toISOString());
      expect(snapshot.providers.map((provider) => provider.provider)).toEqual(["codex", "claude-code"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("skips loading and omits the Codex card when hidden", async () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".codex", "auth.json"), {
        tokens: { access_token: "codex-access", account_id: "account-1" },
      });
      let fetched = false;

      const snapshot = await loadUsageQuotaSnapshot({
        now: NOW,
        homeDir,
        env: {},
        hideCodexQuota: true,
        codexFetcher: async () => {
          fetched = true;
          return {};
        },
      });

      expect(fetched).toBe(false);
      expect(snapshot.providers.map((provider) => provider.provider)).toEqual(["claude-code"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("omits the Claude Code card when hidden", async () => {
    const homeDir = makeHome();
    try {
      const snapshot = await loadUsageQuotaSnapshot({
        now: NOW,
        homeDir,
        env: {},
        hideClaudeQuota: true,
        codexFetcher: async () => ({}),
      });

      expect(snapshot.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns an empty provider list but records hidden providers when both quotas are hidden", async () => {
    const homeDir = makeHome();
    try {
      const snapshot = await loadUsageQuotaSnapshot({
        now: NOW,
        homeDir,
        env: {},
        hideCodexQuota: true,
        hideClaudeQuota: true,
        codexFetcher: async () => ({}),
      });

      expect(snapshot.providers).toEqual([]);
      expect(snapshot.hiddenProviders).toEqual(["codex", "claude-code"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E tests — realistic end-to-end scenarios with both providers
// ---------------------------------------------------------------------------

describe("quota E2E", () => {
  it("produces a full snapshot with both providers using real-world response formats", async () => {
    const homeDir = makeHome();
    try {
      // Codex: realistic API response with used_percent in 0-100 scale
      writeJson(path.join(homeDir, ".codex", "auth.json"), {
        tokens: { access_token: "codex-token", account_id: "acc-1" },
      });

      // Claude: snapshot file mimicking our statusline bridge output
      writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
        source: "agent-recall-statusline",
        updated_at: "2026-06-01T11:59:00.000Z",
        plan: "max",
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: 1_807_000_000 },
          seven_day: { used_percentage: 15, resets_at: 1_807_400_000 },
        },
      });

      const snapshot = await loadUsageQuotaSnapshot({
        now: NOW,
        homeDir,
        env: {},
        codexFetcher: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 25, reset_at: 1_807_000_000 },
            secondary_window: { used_percent: 60, reset_at: 1_807_400_000 },
          },
        }),
      });

      // Structure
      expect(snapshot.generatedAt).toBe(NOW.toISOString());
      expect(snapshot.providers).toHaveLength(2);

      // Codex card
      const codexCard = snapshot.providers.find((p) => p.provider === "codex")!;
      expect(codexCard.status).toBe("supported");
      expect(codexCard.plan).toBe("Pro");
      expect(codexCard.quotas).toHaveLength(2);
      expect(codexCard.quotas[0]).toMatchObject({ key: "five_hour", label: "5h", usedPercent: 25, remainingPercent: 75 });
      expect(codexCard.quotas[1]).toMatchObject({ key: "seven_day", label: "7d", usedPercent: 60, remainingPercent: 40 });

      // Claude card
      const claudeCard = snapshot.providers.find((p) => p.provider === "claude-code")!;
      expect(claudeCard.status).toBe("supported");
      expect(claudeCard.plan).toBe("Max");
      expect(claudeCard.quotas).toHaveLength(2);
      expect(claudeCard.quotas[0]).toMatchObject({ key: "five_hour", label: "5h", usedPercent: 42, remainingPercent: 58 });
      expect(claudeCard.quotas[1]).toMatchObject({ key: "seven_day", label: "7d", usedPercent: 15, remainingPercent: 85 });

      // Display strings always sum to 100
      for (const provider of snapshot.providers) {
        for (const q of provider.quotas) {
          const used = parseInt(q.usedDisplay, 10);
          const remaining = parseInt(q.remainingDisplay, 10);
          expect(used + remaining).toBe(100);
        }
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("parses Claude quota from onwatch/kaboo quotas format with percentage suffix", async () => {
    const homeDir = makeHome();
    try {
      writeJson(path.join(homeDir, ".claude", "kaboo-statusline.json"), {
        source: "kaboo",
        plan: "pro",
        quotas: {
          five_hour: { label: "5h", used_percentage: 18, remaining_percentage: 82, resets_at: "2027-04-05T13:00:00.000Z" },
          seven_day: { label: "7d", used_percentage: 35, resets_at: "2027-04-10T13:00:00.000Z" },
        },
      });

      const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });

      expect(card.status).toBe("supported");
      expect(card.plan).toBe("Pro");
      expect(card.source).toBe("kaboo");
      expect(card.quotas).toHaveLength(2);
      expect(card.quotas[0]).toMatchObject({ key: "five_hour", usedPercent: 18, remainingPercent: 82 });
      expect(card.quotas[0].resetsAt).toBe("2027-04-05T13:00:00.000Z");
      expect(card.quotas[0].stale).toBe(false);
      // seven_day: only used_percentage provided, remaining computed
      expect(card.quotas[1]).toMatchObject({ key: "seven_day", usedPercent: 35, remainingPercent: 65 });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  describe("stale detection", () => {
    it("marks quota as stale when reset_at is more than 60s in the past", () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          rate_limits: {
            five_hour: { used_percentage: 50, resets_at: 1_808_000_000 },
          },
        });

        // NOW = 2026-06-01T12:00:00Z, reset_at = 1_808_000_000 ≈ 2027-04-17
        // That's in the future — should NOT be stale
        const cardFuture = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(cardFuture.quotas[0].stale).toBe(false);

        // A reset time 2 minutes ago — should be stale
        const twoMinAgo = new Date(NOW.getTime() - 120_000);
        const pastUnix = Math.floor(twoMinAgo.getTime() / 1000);
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          rate_limits: {
            five_hour: { used_percentage: 50, resets_at: pastUnix },
          },
        });
        const cardPast = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(cardPast.quotas[0].stale).toBe(true);

        // A reset time 30 seconds ago — within grace period, NOT stale
        const thirtySecAgo = new Date(NOW.getTime() - 30_000);
        const graceUnix = Math.floor(thirtySecAgo.getTime() / 1000);
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          rate_limits: {
            five_hour: { used_percentage: 50, resets_at: graceUnix },
          },
        });
        const cardGrace = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(cardGrace.quotas[0].stale).toBe(false);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("auto-detects staleness from resets_at when quotas format omits the stale field", () => {
      const homeDir = makeHome();
      try {
        const pastIso = new Date(NOW.getTime() - 120_000).toISOString();
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          quotas: {
            five_hour: { label: "5h", used_percentage: 50, resets_at: pastIso },
          },
        });

        const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.quotas[0].stale).toBe(true);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("preserves stale flag from quotas format", () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          quotas: {
            five_hour: { label: "5h", used_percentage: 50, resets_at: "2027-01-01T00:00:00.000Z", stale: true },
          },
        });

        const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.quotas[0].stale).toBe(true);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe("display rounding", () => {
    function displayFor(usedPercent: number, remainingPercent: number): [string, string] {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".claude", "statusline-snapshot.json"), {
          rate_limits: {
            five_hour: { used_percentage: usedPercent, remaining_percentage: remainingPercent },
          },
        });
        const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        return [card.quotas[0].usedDisplay, card.quotas[0].remainingDisplay];
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    }

    it("always sums to 100% regardless of fractional used value", () => {
      const pairs: Array<[number, number, string, string]> = [
        [25, 75, "25%", "75%"],
        [0, 100, "0%", "100%"],
        [100, 0, "100%", "0%"],
        [23.5, 76.5, "24%", "76%"],
        [23.4, 76.6, "23%", "77%"],
        [0.1, 99.9, "0%", "100%"],
        [99.7, 0.3, "100%", "0%"],
      ];
      for (const [usedPct, remainingPct, expectedUsed, expectedRemaining] of pairs) {
        const [used, remaining] = displayFor(usedPct, remainingPct);
        expect(used).toBe(expectedUsed);
        expect(remaining).toBe(expectedRemaining);
        expect(parseInt(used, 10) + parseInt(remaining, 10)).toBe(100);
      }
    });
  });

  describe("edge cases", () => {
    it("returns not_configured for Codex without auth.json", async () => {
      const homeDir = makeHome();
      try {
        const snapshot = await loadUsageQuotaSnapshot({
          now: NOW,
          homeDir,
          env: {},
        });
        const codex = snapshot.providers.find((p) => p.provider === "codex")!;
        expect(codex.status).toBe("not_configured");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("shows unsupported_api_key for API-key-only Codex auth", async () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".codex", "auth.json"), {
          OPENAI_API_KEY: "sk-test-key",
        });

        const card = await loadCodexQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.status).toBe("unsupported_api_key");
        expect(card.quotas).toEqual([]);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("returns empty quotas when Codex response has no windows", async () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".codex", "auth.json"), {
          tokens: { access_token: "codex-token", account_id: "acc-1" },
        });

        const card = await loadCodexQuotaCard({
          now: NOW,
          homeDir,
          env: {},
          codexFetcher: async () => ({ plan_type: "free" }),
        });

        expect(card.status).toBe("supported");
        expect(card.plan).toBe("Free");
        expect(card.quotas).toEqual([]);
        expect(card.detail).toContain("did not include limits");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("returns not_configured for Claude without any statusline file", () => {
      const homeDir = makeHome();
      try {
        const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.status).toBe("not_configured");
        expect(card.quotas).toEqual([]);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("reports error when Codex auth.json is invalid JSON", async () => {
      const homeDir = makeHome();
      try {
        mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
        writeFileSync(path.join(homeDir, ".codex", "auth.json"), "{not valid json", "utf8");

        const card = await loadCodexQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.status).toBe("error");
        expect(card.detail).toContain("not valid JSON");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("reports error when Claude statusline file is invalid JSON", () => {
      const homeDir = makeHome();
      try {
        mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
        writeFileSync(path.join(homeDir, ".claude", "statusline-snapshot.json"), "{bad json", "utf8");

        const card = loadClaudeQuotaCard({ now: NOW, homeDir, env: {} });
        expect(card.status).toBe("error");
        expect(card.detail).toContain("not valid JSON");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe("reset time edge cases", () => {
    it("exposes resetsAt as ISO string and is never stale for future times", async () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".codex", "auth.json"), {
          tokens: { access_token: "codex-token", account_id: "acc-1" },
        });

        const card = await loadCodexQuotaCard({
          now: NOW,
          homeDir,
          env: {},
          codexFetcher: async () => ({
            rate_limit: {
              primary_window: { used_percent: 50, reset_at: 1_807_800_000 },
            },
          }),
        });

        expect(card.quotas[0].resetsAt).toBe("2027-04-15T14:40:00.000Z");
        expect(card.quotas[0].stale).toBe(false);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("computes reset time from reset_after_seconds relative to now", async () => {
      const homeDir = makeHome();
      try {
        writeJson(path.join(homeDir, ".codex", "auth.json"), {
          tokens: { access_token: "codex-token", account_id: "acc-1" },
        });

        const card = await loadCodexQuotaCard({
          now: NOW, // 2026-06-01T12:00:00Z
          homeDir,
          env: {},
          codexFetcher: async () => ({
            rate_limit: {
              primary_window: { used_percent: 50, reset_after_seconds: 7200 },
            },
          }),
        });

        // 12:00:00 + 7200s = 14:00:00
        expect(card.quotas[0].resetsAt).toBe("2026-06-01T14:00:00.000Z");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });
});
