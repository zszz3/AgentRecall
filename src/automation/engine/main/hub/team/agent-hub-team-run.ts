import { TaskState, TeamRunState } from "../state/agent-hub-state";

export function composeTeamStepPrompt(run: TeamRunState, stepIndex: number): string {
  const step = run.steps[stepIndex];
  const previousArtifacts = run.steps
    .slice(0, stepIndex)
    .filter((item) => item.artifact?.trim())
    .map((item, index) => [`### ${index + 1}. ${item.roleName}`, item.artifact].join("\n"))
    .join("\n\n");

  return [
    `You are running step ${stepIndex + 1} of ${run.steps.length} in the agent team "${run.teamName}".`,
    step ? `Role: ${step.roleName}` : "",
    "",
    "## Member Prompt",
    step?.prompt.trim() || "No member-specific prompt provided.",
    "",
    "## Original Task",
    run.prompt,
    "",
    "## Target",
    run.target ? `${run.target.label}: ${run.target.value}` : run.workDir,
    "",
    "## Shared Context",
    run.sharedContextSnapshot.trim() || "No shared context provided.",
    "",
    "## Previous Agent Artifacts",
    previousArtifacts || "No previous artifacts. You are the first step.",
    "",
    "## Instructions",
    "Produce a concise artifact for the next agent in this pipeline. Include decisions, risks, and concrete next steps when relevant.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function extractTaskArtifact(task: TaskState): string {
  return task.messages
    .filter((message) => message.role === "assistant" && message.content.trim())
    .map((message) => message.content.trim())
    .join("\n\n")
    .trim();
}

export function failTeamStepFromTask(input: {
  run: TeamRunState;
  taskStepId: string | undefined;
  error: string;
  now?: number;
}): void {
  if (!input.taskStepId) return;
  const step = input.run.steps.find((item) => item.id === input.taskStepId);
  if (!step || step.status !== "running") return;
  const now = input.now ?? Date.now();
  step.status = "failed";
  step.lastError = input.error;
  step.completedAt = now;
  input.run.status = "failed";
  input.run.lastError = input.error;
  input.run.updatedAt = now;
}

export function finishTeamStepFromTask(input: {
  run: TeamRunState;
  task: TaskState;
  now?: number;
}): { startStepIndexes: number[] } {
  if (!input.task.teamStepId) return { startStepIndexes: [] };
  const stepIndex = input.run.steps.findIndex((step) => step.id === input.task.teamStepId);
  const step = stepIndex >= 0 ? input.run.steps[stepIndex] : undefined;
  if (!step || step.status !== "running") return { startStepIndexes: [] };
  const now = input.now ?? Date.now();

  if (input.task.status === "completed") {
    step.status = "completed";
    step.artifact = extractTaskArtifact(input.task);
    step.lastError = undefined;
    step.completedAt = now;
    input.run.updatedAt = now;

    if (input.run.mode === "parallel") {
      if (input.run.steps.every((item) => item.status === "completed")) {
        input.run.status = "completed";
        input.run.currentStepIndex = stepIndex;
      }
      return { startStepIndexes: [] };
    }

    if (input.run.mode === "supervisor") {
      return advanceSupervisorRun(input.run, stepIndex);
    }

    const nextStep = input.run.steps[stepIndex + 1];
    if (nextStep) {
      input.run.currentStepIndex = stepIndex + 1;
      return { startStepIndexes: [stepIndex + 1] };
    }
    input.run.status = "completed";
    input.run.currentStepIndex = stepIndex;
    return { startStepIndexes: [] };
  }

  if (input.task.status === "stopped") {
    step.status = "stopped";
    step.lastError = input.task.lastError ?? "Stopped";
    step.completedAt = now;
    input.run.status = "stopped";
    input.run.lastError = step.lastError;
    input.run.updatedAt = now;
    return { startStepIndexes: [] };
  }

  if (input.task.status === "failed") {
    failTeamStepFromTask({
      run: input.run,
      taskStepId: input.task.teamStepId,
      error: input.task.lastError ?? "Agent step failed",
      now,
    });
  }
  return { startStepIndexes: [] };
}

export function beginTeamRunStep(input: {
  run: TeamRunState;
  stepIndex: number;
  composePrompt: (run: TeamRunState, stepIndex: number) => string;
  createTask: (request: { prompt: string; configuredAgentId: string; workDir: string }) => TaskState;
  now?: number;
}): { task: TaskState } | { completed: true } | undefined {
  const now = input.now ?? Date.now();
  const step = input.run.steps[input.stepIndex];
  if (!step) {
    input.run.status = "completed";
    input.run.updatedAt = now;
    return { completed: true };
  }
  if (step.status !== "queued") return undefined;

  const task = input.createTask({
    prompt: input.composePrompt(input.run, input.stepIndex),
    configuredAgentId: step.configuredAgentId,
    workDir: input.run.workDir,
  });
  task.title = `${input.run.teamName}: ${step.roleName}`;
  task.teamRunId = input.run.id;
  task.teamStepId = step.id;

  step.status = "running";
  step.taskId = task.id;
  step.startedAt = now;
  step.lastError = undefined;
  input.run.currentStepIndex = input.stepIndex;
  input.run.updatedAt = now;
  return { task };
}

function advanceSupervisorRun(run: TeamRunState, completedStepIndex: number): { startStepIndexes: number[] } {
  if (run.steps.length <= 1) return { startStepIndexes: [] };
  const synthesisIndex = run.steps.length - 1;
  if (completedStepIndex === 0) {
    const workerIndexes = run.steps.slice(1, synthesisIndex).map((_step, offset) => offset + 1);
    if (workerIndexes.length === 0) {
      run.currentStepIndex = synthesisIndex;
      return { startStepIndexes: [synthesisIndex] };
    }
    run.currentStepIndex = workerIndexes[0] ?? 0;
    return { startStepIndexes: workerIndexes };
  }

  if (completedStepIndex > 0 && completedStepIndex < synthesisIndex) {
    const workersComplete = run.steps.slice(1, synthesisIndex).every((item) => item.status === "completed");
    if (workersComplete) {
      run.currentStepIndex = synthesisIndex;
      return { startStepIndexes: [synthesisIndex] };
    }
    return { startStepIndexes: [] };
  }

  if (completedStepIndex === synthesisIndex) {
    run.status = "completed";
    run.currentStepIndex = synthesisIndex;
  }
  return { startStepIndexes: [] };
}
