import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import type { PersistedAppStateV5 } from "./agent-hub-persistence";
import { PostgresAppStore } from "./postgres-store";

describe("PostgreSQL AgentHub persistence", () => {
  let database: PostgresDatabase;
  let store: PostgresAppStore;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    store = new PostgresAppStore(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("persists chat runtime state and Workflow trajectories transactionally", async () => {
    const payload = {
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      sessions: [{
        id: "chat-1",
        title: "Fix search",
        configuredAgentId: "codex",
        runtimeState: { state: "idle" },
        runtimeConversation: {
          runtimeId: "codex",
          sessionId: "provider-session",
          codecVersion: "1",
          payload: {},
        },
        createdAt: 1_000,
        updatedAt: 2_000,
      }],
      messages: [{
        id: "message-1",
        chatId: "chat-1",
        role: "assistant",
        content: "Done",
        timestamp: 1_500,
      }],
      events: [{
        id: "event-1",
        chatId: "chat-1",
        messageId: "message-1",
        type: "meta",
        content: "completed",
        timestamp: 1_600,
      }],
      workflowStore: {
        activeWorkflowId: "workflow-1",
        workflows: [{
          workflowId: "workflow-1",
          title: "Review",
          status: "completed",
          revision: 1,
          configuredAgentId: "codex",
          modelId: "gpt",
          objective: "Review the change",
          messages: [{
            id: "workflow-message-1",
            role: "assistant",
            content: "Approval denied",
            events: [{
              id: "workflow-tool-1",
              type: "tool_result",
              name: "workflow_update",
              content: "denied",
              timestamp: 1_650,
              metadata: { status: "failed" },
            }],
          }],
          reply: "",
          runProgress: [{
            nodeId: "review",
            title: "Review",
            status: "completed",
            inputSummary: { objective: "Review the change" },
            outputs: { result: "approved" },
            telemetry: {
              provider: "openai",
              runtimeId: "codex",
              channelId: "channel-1",
              modelId: "gpt",
              attempt: 1,
              startedAt: 1_700,
              finishedAt: 1_900,
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              estimatedCost: 0.002,
            },
          }],
          runContextDocument: "",
          contextDocument: "",
          runIds: ["run-1"],
          createdAt: 1_000,
          updatedAt: 2_000,
        }],
        runs: [{
          runId: "run-1",
          workflowId: "workflow-1",
          status: "completed",
          triggerSource: "scheduled",
          configurationSnapshot: {
            configuredAgentId: "codex",
            runtimeId: "codex",
            channelId: "channel-1",
            modelId: "gpt",
            reasoningEffort: "high",
            agentRevision: 2,
          },
          progress: [{
            nodeId: "review",
            title: "Review",
            status: "completed",
            inputSummary: { objective: "Review the change" },
            outputs: { result: "approved" },
            telemetry: {
              provider: "openai",
              runtimeId: "codex",
              channelId: "channel-1",
              modelId: "gpt",
              attempt: 1,
              startedAt: 1_700,
              finishedAt: 1_900,
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              estimatedCost: 0.002,
            },
          }],
          events: [{
            type: "node_completed",
            nodeId: "review",
            at: 1_900,
            sequence: 0,
            summary: "Looks good",
            artifactRefs: [{
              kind: "text",
              title: "Review",
              content: "No blockers",
            }],
          }],
          contextDocument: "",
          startedAt: 1_700,
          finishedAt: 2_000,
        }],
      },
    } as unknown as PersistedAppStateV5;

    await store.save(payload);
    const restored = await store.load() as Record<string, unknown>;

    expect(restored).toMatchObject({
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      sessions: [{
        id: "chat-1",
        runtimeConversation: expect.objectContaining({
          sessionId: "provider-session",
        }),
      }],
      workflowStore: {
        activeWorkflowId: "workflow-1",
        workflows: [{
          workflowId: "workflow-1",
          runIds: ["run-1"],
          messages: [{
            id: "workflow-message-1",
            events: [{
              id: "workflow-tool-1",
              type: "tool_result",
              metadata: { status: "failed" },
            }],
          }],
        }],
        runs: [{
          runId: "run-1",
          triggerSource: "scheduled",
          configurationSnapshot: expect.objectContaining({
            configuredAgentId: "codex",
            runtimeId: "codex",
          }),
          progress: [{
            inputSummary: { objective: "Review the change" },
            outputs: { result: "approved" },
            telemetry: expect.objectContaining({
              totalTokens: 15,
              estimatedCost: 0.002,
            }),
          }],
          events: [{
            sequence: 0,
            summary: "Looks good",
            artifactRefs: [{ title: "Review", content: "No blockers" }],
          }],
        }],
      },
    });

    const counts = await database.query<{
      chats: number;
      workflows: number;
      runs: number;
      events: number;
    }>(`
      select
        (select count(*)::integer from agent_recall.automation_chats) as chats,
        (select count(*)::integer from agent_recall.workflows) as workflows,
        (select count(*)::integer from agent_recall.workflow_runs) as runs,
        (select count(*)::integer from agent_recall.workflow_events) as events
    `);
    expect(counts.rows[0]).toEqual({
      chats: 1,
      workflows: 1,
      runs: 1,
      events: 1,
    });
  });
});
