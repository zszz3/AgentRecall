import { describe, expect, it, vi } from "vitest";
import { WorkflowPlanningService, workflowPlanningStateSchema } from "./workflow-planning-service";
import type { WorkflowPlanningRequest, WorkflowProposal } from "../../automation/engine/shared/workflow/model";

const proposal: WorkflowProposal = {
  name: "Summarize", description: "Summarize a document", inputs: [],
  nodes: [{ id: "summarize", kind: "agent", title: "Summary", goal: "Summarize", agentId: "agent", inputs: [],
    outputs: [{ key: "summary", name: "Summary", description: "Document summary", type: "text", required: true }],
    instructions: ["Keep it concise"], constraints: [], acceptanceCriteria: ["Preserve the main points"] }],
};
const request = (): WorkflowPlanningRequest => ({
  requestId: "request", agentId: "agent", message: "Help summarize documents", intent: "interview",
  definition: { ...structuredClone(proposal), id: "workflow", createdAt: 1, updatedAt: 2 },
});
function setup(output: unknown) {
  const executor = { runOneShot: vi.fn(async () => ({ output: JSON.stringify(output), durationMs: 1 })) };
  const service = new WorkflowPlanningService({ executor, agents: () => [{ id: "agent", name: "Writer" }] });
  return { service, executor };
}

describe("Workflow grill planning", () => {
  it("carries each answer and current manual edits into the next turn without applying the proposal", async () => {
    const { service, executor } = setup({ message: "Who is the audience? I recommend the project team." });
    const input = request();
    const initial = structuredClone(input.definition);
    const first = await service.reply(input, new AbortController().signal);
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(first.proposal).toBeUndefined();
    input.definition.planning = first;
    input.definition.nodes[0]!.goal = "Keep my manual change";
    executor.runOneShot.mockResolvedValueOnce({ output: JSON.stringify({ message: "Ready to review.", proposal }), durationMs: 1 });
    const next = await service.reply({ ...input, message: "The project team", intent: "generate" }, new AbortController().signal);
    expect(next.messages).toHaveLength(4);
    expect(next.proposal).toEqual(proposal);
    expect(input.definition.nodes[0]!.goal).toBe("Keep my manual change");
    const prompt = executor.runOneShot.mock.calls[1] as unknown as [{ prompt: string }];
    expect(prompt[0].prompt).toContain("Who is the audience?");
    expect(prompt[0].prompt).toContain("Keep my manual change");
    expect(initial.planning).toBeUndefined();
  });

  it.each([
    { message: "Invalid", proposal: { ...proposal, nodes: [{ ...proposal.nodes[0], agentId: "invented" }] } },
    { message: "Invalid", proposal: { ...proposal, nodes: [{ ...proposal.nodes[0], inputs: [{ source: "node", nodeId: "summarize", outputKey: "summary" }] }] } },
    { message: "Invalid", proposal: { ...proposal, nodes: [{ kind: "agent" }] } },
  ])("rejects invalid model graphs instead of handing them to the editor", async (output) => {
    await expect(setup(output).service.reply(request(), new AbortController().signal)).rejects.toThrow();
  });

  it("rejects a late result after cancellation and propagates the abort signal", async () => {
    const { service, executor } = setup({ message: "Ready", proposal });
    const controller = new AbortController();
    executor.runOneShot.mockImplementationOnce(async () => {
      controller.abort();
      return { output: JSON.stringify({ message: "Ready", proposal }), durationMs: 1 };
    });
    await expect(service.reply(request(), controller.signal)).rejects.toThrow();
    expect(executor.runOneShot).toHaveBeenCalledWith(expect.any(Object), undefined, controller.signal);
  });

  it("bounds the complete retained conversation, including metadata", () => {
    const state = { agentId: "agent", messages: [] as Array<{ role: "user"; content: string }> };
    expect(workflowPlanningStateSchema.safeParse(state).success).toBe(true);
    state.messages = Array.from({ length: 10 }, () => ({ role: "user", content: "中".repeat(49_000) }));
    const overhead = JSON.stringify(state).length - state.messages.reduce((sum, item) => sum + item.content.length, 0);
    const exact = 500_000 - overhead;
    state.messages = state.messages.map((item, index) => ({ ...item, content: "中".repeat(Math.floor(exact / 10) + (index < exact % 10 ? 1 : 0)) }));
    expect(JSON.stringify(state)).toHaveLength(500_000);
    expect(workflowPlanningStateSchema.safeParse(state).success).toBe(true);
    state.messages[0]!.content += "中";
    expect(workflowPlanningStateSchema.safeParse(state).success).toBe(false);
    expect(workflowPlanningStateSchema.safeParse({ ...state, messages: [{ role: "user", content: "x".repeat(50_001) }] }).success).toBe(false);
  });
});
