import { describe, expect, it } from "vitest";

// The V2 MCP binary is intentionally standalone and has no TypeScript declarations.
// @ts-expect-error -- untyped .mjs binary
import { cleanUserMessageContent, getSession } from "../../bin/agent-recall-mcp.mjs";

describe("V2 MCP user-message cleanup", () => {
  it("removes injected notifications while retaining genuine input", () => {
    expect(cleanUserMessageContent(
      "<subagent_notification source=\"worker\">done</subagent_notification>\n真实输入",
    )).toBe("真实输入");
    expect(cleanUserMessageContent(
      "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.",
    )).toBe("");
    expect(cleanUserMessageContent(
      "<timestamp>Friday</timestamp>\n<system_notification><task>done</task></system_notification>\n<user_query>真实输入</user_query>",
    )).toBe("真实输入");
  });

  it("keeps paging totals aligned when cached rows still contain notifications", async () => {
    const rows = [
      { role: "user", content: "<subagent_notification>done</subagent_notification>" },
      { role: "user", content: "<task-notification>done</task-notification>\n真实输入" },
      { role: "assistant", content: "done" },
    ];
    const database = {
      query: async (sql: string) => {
        if (sql.includes("FROM agent_recall.local_sessions s")) {
          return {
            rows: [{
              session_key: "codex:test",
              source: "codex-cli",
              project_path: "/repo",
              timestamp: new Date("2026-08-01T00:00:00Z"),
              original_title: "Test",
              first_question: "Question",
              custom_title: null,
              ai_summary: null,
            }],
          };
        }
        if (sql.includes("SELECT 1")) return { rows: [{ exists: 1 }] };
        return { rows };
      },
    };

    await expect(getSession(database, { sessionKey: "codex:test", maxMessages: 40 }))
      .resolves.toMatchObject({
        totalMessages: 2,
        returned: 2,
        nextOffset: null,
        messages: [
          { role: "user", content: "真实输入" },
          { role: "assistant", content: "done" },
        ],
      });
  });
});
