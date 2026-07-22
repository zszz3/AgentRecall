import { describe, expect, it, vi } from "vitest";
import { runEvaluation } from "./evaluation-runner";

describe("runEvaluation", () => {
  it("repeats cases and aggregates deterministic scores", async () => {
    const execute = vi.fn(async () => ({
      output: "expected answer",
      durationMs: 4,
    }));
    const run = await runEvaluation({
      experiment: {
        id: "experiment",
        name: "Experiment",
        datasetId: "dataset",
        agentId: "agent",
        evaluatorIds: ["contains"],
        repetitions: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      dataset: {
        id: "dataset",
        name: "Dataset",
        description: "",
        createdAt: 1,
        updatedAt: 1,
        items: [
          {
            id: "case",
            input: "question",
            expectedOutput: "expected",
            metadata: {},
            sequence: 0,
          },
        ],
      },
      evaluators: [
        {
          id: "contains",
          name: "Contains",
          kind: "contains",
          threshold: 1,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      agentRevisionId: "agent:v2",
      execute,
    });
    expect(run.status).toBe("completed");
    expect(run.results).toHaveLength(2);
    expect(run.averageScore).toBe(1);
    expect(run.minimumScore).toBe(1);
    expect(run.passRate).toBe(1);
    expect(run.agentRevisionId).toBe("agent:v2");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("uses a concrete Runtime config for an LLM judge", async () => {
    const execute = vi.fn(async () => ({ output: "answer", durationMs: 3 }));
    const executeJudge = vi.fn(async (_runtimeId: string, _prompt: string) => ({
      output:
        '{"score":0.8,"reason":"good","evidence":["answer"],"failedCriteria":["focus"]}',
      durationMs: 2,
    }));
    const run = await runEvaluation({
      experiment: {
        id: "experiment",
        name: "Experiment",
        datasetId: "dataset",
        agentId: "subject",
        evaluatorIds: ["judge-eval"],
        repetitions: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      dataset: {
        id: "dataset",
        name: "Dataset",
        description: "",
        createdAt: 1,
        updatedAt: 1,
        items: [
          {
            id: "case",
            input: "question",
            expectedOutput: "reference answer",
            metadata: { context: "trusted context" },
            sequence: 0,
          },
        ],
      },
      evaluators: [
        {
          id: "judge-eval",
          name: "Judge",
          kind: "llm_judge",
          runtimeId: "runtime-openai",
          prompt:
            "<Rubric>Evaluate focus.</Rubric>\n<Input>{{input}}</Input>\n<Answer>{{output}}</Answer>\n<OutputFormat>JSON</OutputFormat>",
          threshold: 0.7,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      execute,
      executeJudge,
    });
    expect(run.results[0]?.scores[0]).toMatchObject({
      score: 0.8,
      passed: true,
      reason: "good",
      evidence: ["answer"],
      failedCriteria: ["focus"],
    });
    expect(execute).toHaveBeenCalledWith("subject", "question");
    expect(executeJudge).toHaveBeenCalledWith(
      "runtime-openai",
      expect.stringMatching(/<Input>question<\/Input>[\s\S]*<Answer>answer<\/Answer>/),
    );
    const judgePrompt = executeJudge.mock.calls[0]?.[1] ?? "";
    expect(judgePrompt).not.toContain("reference answer");
    expect(judgePrompt).not.toContain("trusted context");
  });
});
