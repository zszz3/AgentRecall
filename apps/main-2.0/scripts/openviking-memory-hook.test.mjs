import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const {
  findWorkspaceForCwd,
  handleHook,
  estimateTokens,
  recallForWorkspace,
} = require("../bin/openviking-memory-hook.cjs");

function managedManifest(rootPath, overrides = {}) {
  return {
    version: 2,
    baseUrl: "http://127.0.0.1:21933",
    integrations: { claude: true, codex: true, opencode: true },
    workspaces: [{
      id: "workspace-1",
      rootPath,
      accountId: "agent-recall-v2",
      userId: "workspace_user",
      apiKey: "workspace-key",
      recallTokenBudget: 1_200,
      ...overrides,
    }],
  };
}

test("unmanaged directories exit before reading prompt content", async () => {
  const requests = [];
  const input = { cwd: path.join(os.tmpdir(), "unmanaged-project") };
  Object.defineProperty(input, "prompt", {
    get() {
      throw new Error("prompt must stay unread");
    },
  });

  const result = await handleHook(input, {
    agent: "claude",
    event: "UserPromptSubmit",
    manifest: managedManifest(path.join(os.tmpdir(), "managed-project")),
    fetchImpl: async (...args) => {
      requests.push(args);
      return new Response();
    },
    realpathSync: (value) => path.resolve(value),
  });

  assert.deepEqual(result, {});
  assert.equal(requests.length, 0);
});

test("managed prompt recall combines fixed core memory with session-aware search", async () => {
  const rootPath = path.join(os.tmpdir(), "managed-project");
  const requests = [];
  const result = await handleHook({
    cwd: rootPath,
    prompt: "How did we migrate the database?",
    session_id: "session-1",
  }, {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/v1/content/read")) {
        const uri = new URL(String(url)).searchParams.get("uri");
        return Response.json({
          status: "ok",
          result: {
            content: uri?.endsWith("/identity.md")
              ? "You are the project's coding assistant."
              : "Prefer evidence from the current repository.",
          },
        });
      }
      return Response.json({
        status: "ok",
        result: {
          memories: [
            {
              uri: "viking://user/memories/identity.md",
              abstract: "You are the project's coding assistant.",
              score: 0.99,
            },
            {
              uri: "viking://user/memories/events/migration.md",
              abstract: "Use the staged migration plan.",
              score: 0.91,
            },
          ],
        },
      });
    },
    realpathSync: (value) => path.resolve(value),
  });

  const searchRequest = requests.find((request) => request.url.endsWith("/api/v1/search/search"));
  assert.ok(searchRequest);
  assert.equal(JSON.parse(searchRequest.init.body).session_id.startsWith("agent-recall-"), true);
  assert.equal(searchRequest.init.headers["X-API-Key"], "workspace-key");
  assert.equal(searchRequest.init.headers["X-OpenViking-User"], "workspace_user");
  assert.equal(requests.filter((request) => request.url.includes("/api/v1/content/read")).length, 2);
  assert.match(result.hookSpecificOutput.additionalContext, /project's coding assistant/);
  assert.match(result.hookSpecificOutput.additionalContext, /evidence from the current repository/);
  assert.match(result.hookSpecificOutput.additionalContext, /staged migration plan/);
  assert.equal(result.hookSpecificOutput.additionalContext.match(/project's coding assistant/gu)?.length, 1);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("unavailable recall fails open without a second search attempt", async () => {
  const rootPath = path.join(os.tmpdir(), "managed-project");
  const requests = [];
  const result = await handleHook({
    cwd: rootPath,
    prompt: "Continue the current task.",
    session_id: "session-1",
  }, {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath),
    timeoutMs: 5,
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
    realpathSync: (value) => path.resolve(value),
  });

  assert.deepEqual(result, {});
  assert.equal(requests.filter((url) => url.includes("/api/v1/search/")).length, 1);
  assert.equal(requests.length, 3);
});

test("the internal request budget stays well below the Codex hook deadline", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "bin", "openviking-memory-hook.cjs"),
    "utf8",
  );

  assert.match(source, /const REQUEST_TIMEOUT_MS = 2_000;/u);
});

test("no-op UserPromptSubmit and Stop CLI hooks succeed without emitting invalid JSON", (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-hook-cli-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const manifestPath = path.join(testHome, "hook-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    baseUrl: "http://127.0.0.1:21933",
    integrations: { claude: true, codex: true, opencode: false },
    workspaces: [],
  }));
  const hookPath = path.join(import.meta.dirname, "..", "bin", "openviking-memory-hook.cjs");

  for (const event of ["UserPromptSubmit", "Stop"]) {
    const result = spawnSync(process.execPath, [
      hookPath,
      "--agent", "codex",
      "--event", event,
      "--manifest", manifestPath,
    ], {
      input: JSON.stringify({ cwd: testHome, session_id: "session-1", prompt: "diagnostic" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${event} must keep stdout empty when it has no hook output`);
    assert.equal(result.stderr, "");
  }
});

test("managed Stop appends once and waits for the session lifecycle to commit", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-hook-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const transcriptPath = path.join(testHome, "transcript.jsonl");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: "user", content: "The release checklist has one user-facing bullet." } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/private/config" } }] } }),
    JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "API_KEY=must-not-be-saved" }] } }),
    JSON.stringify({ message: { role: "assistant", content: "I will keep the checklist." } }),
  ].join("\n"));
  const requests = [];
  const options = {
    agent: "claude",
    event: "Stop",
    manifest: managedManifest(rootPath),
    stateDir: path.join(testHome, "state"),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ status: "ok", result: { task_id: "task-1" } });
    },
    realpathSync: (value) => path.resolve(value),
  };
  const input = {
    cwd: rootPath,
    session_id: "session-1",
    transcript_path: transcriptPath,
  };

  assert.deepEqual(await handleHook(input, options), {});
  assert.deepEqual(await handleHook(input, options), {});

  assert.equal(requests.filter((request) => request.url.endsWith("?auto_create=true")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith("/messages/batch")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith("/commit")).length, 0);
  const batch = requests.find((request) => request.url.endsWith("/messages/batch"));
  const messages = JSON.parse(batch.init.body).messages;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(messages[1].content, /Execution summary: Read \(succeeded\)/);
  assert.doesNotMatch(messages[1].content, /private\/config|must-not-be-saved|API_KEY/);

  await handleHook(input, { ...options, event: "PreCompact" });
  assert.equal(requests.filter((request) => request.url.endsWith("/commit")).length, 1);
  const stateFile = fs.readdirSync(options.stateDir).find((name) => name.endsWith(".json"));
  const state = JSON.parse(fs.readFileSync(path.join(options.stateDir, stateFile), "utf8"));
  assert.equal(state.sourceSessionId, "session-1");
  assert.equal(state.commitTasks[0].sourceSessionId, "session-1");
  assert.ok(state.commitTasks[0].inputChars > 0);
  assert.equal(state.commitTasks[0].toolCount, 1);

  const recallRequests = [];
  await handleHook({
    cwd: rootPath,
    session_id: "session-1",
    prompt: "Continue with that.",
  }, {
    ...options,
    event: "UserPromptSubmit",
    fetchImpl: async (url, init) => {
      recallRequests.push({ url: String(url), init });
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "" } });
      }
      return Response.json({ status: "ok", result: { memories: [] } });
    },
  });
  const search = recallRequests.find((request) => request.url.endsWith("/api/v1/search/search"));
  assert.ok(search);
  const query = JSON.parse(search.init.body).query;
  assert.match(query, /Continue with that/);
  assert.match(query, /The release checklist has one user-facing bullet/);
  assert.match(query, /I will keep the checklist/);

  const clearRequests = [];
  await handleHook({
    cwd: rootPath,
    session_id: "session-1",
    prompt: "Explain the production database migration plan.",
  }, {
    ...options,
    event: "UserPromptSubmit",
    fetchImpl: async (url, init) => {
      clearRequests.push({ url: String(url), init });
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "" } });
      }
      return Response.json({ status: "ok", result: { memories: [] } });
    },
  });
  const clearSearch = clearRequests.find((request) => request.url.endsWith("/api/v1/search/search"));
  const clearQuery = JSON.parse(clearSearch.init.body).query;
  assert.equal(clearQuery, "Explain the production database migration plan.");
});

test("concurrent Stop hooks serialize the same turn before appending", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-parallel-stop-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const transcriptPath = path.join(testHome, "transcript.jsonl");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: "user", content: "Capture this turn once." } }),
    JSON.stringify({ message: { role: "assistant", content: "Captured once." } }),
  ].join("\n"));
  const requests = [];
  const options = {
    agent: "claude",
    event: "Stop",
    manifest: managedManifest(rootPath),
    stateDir: path.join(testHome, "state"),
    fetchImpl: async (url) => {
      requests.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ status: "ok", result: {} });
    },
    realpathSync: (value) => path.resolve(value),
  };
  const input = {
    cwd: rootPath,
    session_id: "session-parallel",
    transcript_path: transcriptPath,
  };

  await Promise.all([handleHook(input, options), handleHook(input, options)]);

  assert.equal(requests.filter((url) => url.endsWith("?auto_create=true")).length, 1);
  assert.equal(requests.filter((url) => url.endsWith("/messages/batch")).length, 1);
});

test("vague continuation ignores corrupt handoff timestamps", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-handoff-order-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const stateDir = path.join(testHome, "state");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "000-invalid.json"), JSON.stringify({
    workspaceId: "workspace-1",
    sessionId: "old-session",
    updatedAt: "not-a-date",
    recentTurns: [{ user: "Wrong handoff", assistant: "Ignore this" }],
  }));
  fs.writeFileSync(path.join(stateDir, "zzz-valid.json"), JSON.stringify({
    workspaceId: "workspace-1",
    sessionId: "latest-session",
    updatedAt: "2026-08-05T00:00:00.000Z",
    recentTurns: [{ user: "Correct handoff", assistant: "Use this" }],
  }));
  const requests = [];

  await handleHook({
    cwd: rootPath,
    session_id: "new-session",
    prompt: "Continue with that.",
  }, {
    agent: "claude",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath),
    stateDir,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "" } });
      }
      return Response.json({ status: "ok", result: { memories: [] } });
    },
    realpathSync: (value) => path.resolve(value),
  });

  const search = requests.find((request) => request.url.endsWith("/api/v1/search/search"));
  const query = JSON.parse(search.init.body).query;
  assert.match(query, /Correct handoff/u);
  assert.doesNotMatch(query, /Wrong handoff/u);
});

test("commit keeps turns captured while the request is in flight", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-concurrent-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const transcriptPath = path.join(testHome, "transcript.jsonl");
  const stateDir = path.join(testHome, "state");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: "user", content: "Remember the first turn." } }),
    JSON.stringify({ message: { role: "assistant", content: "First turn captured." } }),
  ].join("\n"));
  const manifest = managedManifest(rootPath);
  const baseOptions = {
    agent: "codex",
    manifest,
    stateDir,
    realpathSync: (value) => path.resolve(value),
  };
  await handleHook({
    cwd: rootPath,
    session_id: "session-1",
    transcript_path: transcriptPath,
  }, {
    ...baseOptions,
    event: "Stop",
    fetchImpl: async () => Response.json({ status: "ok", result: {} }),
  });
  const statePath = path.join(stateDir, fs.readdirSync(stateDir).find((name) => name.endsWith(".json")));
  const beforeCommit = JSON.parse(fs.readFileSync(statePath, "utf8"));

  await handleHook({ cwd: rootPath, session_id: "session-1" }, {
    ...baseOptions,
    event: "PreCompact",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/commit")) {
        const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
        fs.writeFileSync(statePath, JSON.stringify({
          ...current,
          pendingTokenEstimate: Number(current.pendingTokenEstimate || 0) + 80,
          pendingEvidence: [
            ...current.pendingEvidence,
            { id: "turn-2", tokenEstimate: 80, inputChars: 320, toolCount: 2 },
          ],
          updatedAt: "2026-08-05T00:03:01.000Z",
        }));
        return Response.json({ status: "ok", result: { task_id: "task-concurrent" } });
      }
      return Response.json({ status: "ok", result: {} });
    },
  });

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.pendingTokenEstimate, 80);
  assert.deepEqual(state.pendingEvidence.map((item) => item.id), ["turn-2"]);
  assert.equal(state.commitTasks[0].taskId, "task-concurrent");
  assert.deepEqual(state.commitTasks[0].sourceTurnIds, beforeCommit.pendingEvidence.map((item) => item.id));
});

test("managed Stop commits automatically after the pending token threshold", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-threshold-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  fs.mkdirSync(rootPath, { recursive: true });
  const requests = [];

  await handleHook({
    cwd: rootPath,
    session_id: "session-threshold",
    prompt: "A sufficiently substantial task update.",
    last_assistant_message: "A completed result with enough detail to cross the test threshold.",
  }, {
    agent: "claude",
    event: "Stop",
    manifest: managedManifest(rootPath),
    stateDir: path.join(testHome, "state"),
    commitTokenThreshold: 1,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ status: "ok", result: {} });
    },
    realpathSync: (value) => path.resolve(value),
  });

  assert.equal(requests.filter((request) => request.url.endsWith("/messages/batch")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith("/commit")).length, 1);
  const stateFile = fs.readdirSync(path.join(testHome, "state")).find((name) => name.endsWith(".json"));
  const state = JSON.parse(fs.readFileSync(path.join(testHome, "state", stateFile), "utf8"));
  assert.ok(state.pendingTokenEstimate > 0);
  assert.equal(state.commitRequest, undefined);
});

test("managed Stop commits when the user explicitly asks to remember the result", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-remember-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  fs.mkdirSync(rootPath, { recursive: true });
  const requests = [];

  await handleHook({
    cwd: rootPath,
    session_id: "session-remember",
    prompt: "请记住：这个项目发布前必须更新用户说明。",
    last_assistant_message: "记住了，之后会按这个规则执行。",
  }, {
    agent: "claude",
    event: "Stop",
    manifest: managedManifest(rootPath),
    stateDir: path.join(testHome, "state"),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ status: "ok", result: {} });
    },
    realpathSync: (value) => path.resolve(value),
  });

  assert.equal(requests.filter((request) => request.url.endsWith("/commit")).length, 1);
});

test("a vague new session receives the latest handoff from the same workspace", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-handoff-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const stateDir = path.join(testHome, "state");
  fs.mkdirSync(rootPath, { recursive: true });
  const baseOptions = {
    agent: "claude",
    manifest: managedManifest(rootPath),
    stateDir,
    fetchImpl: async () => Response.json({ status: "ok", result: {} }),
    realpathSync: (value) => path.resolve(value),
  };

  await handleHook({
    cwd: rootPath,
    session_id: "previous-session",
    prompt: "先完成运行时配置页面。",
    last_assistant_message: "配置页面已经完成，下一步需要补启动验证。",
  }, { ...baseOptions, event: "Stop" });

  const requests = [];
  await handleHook({
    cwd: rootPath,
    session_id: "new-session",
    prompt: "继续做吧",
  }, {
    ...baseOptions,
    event: "UserPromptSubmit",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/v1/content/read")) return Response.json({ status: "ok", result: { content: "" } });
      return Response.json({ status: "ok", result: { memories: [] } });
    },
  });

  const search = requests.find((request) => request.url.endsWith("/api/v1/search/search"));
  const query = JSON.parse(search.init.body).query;
  assert.match(query, /先完成运行时配置页面/);
  assert.match(query, /下一步需要补启动验证/);
});

test("managed prompt recall keeps useful category diversity", async () => {
  const rootPath = path.join(os.tmpdir(), "managed-project");
  const memories = [
    ["preferences/one.md", "preference one"],
    ["preferences/two.md", "preference two"],
    ["preferences/three.md", "preference three"],
    ["events/one.md", "event one"],
    ["events/two.md", "event two"],
    ["experiences/one.md", "experience one"],
    ["experiences/two.md", "experience two"],
    ["experiences/three.md", "experience three"],
    ["experiences/four.md", "experience four"],
    ["manual/one.md", "manual fallback"],
  ].map(([suffix, abstract]) => ({
    uri: `viking://user/memories/${suffix}`,
    abstract,
  }));

  const result = await handleHook({ cwd: rootPath, prompt: "Plan the next change." }, {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath),
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "" } });
      }
      return Response.json({ status: "ok", result: { memories } });
    },
    realpathSync: (value) => path.resolve(value),
  });

  const contextText = result.hookSpecificOutput.additionalContext;
  assert.match(contextText, /preference one/);
  assert.match(contextText, /preference two/);
  assert.doesNotMatch(contextText, /preference three/);
  assert.match(contextText, /event one/);
  assert.match(contextText, /event two/);
  assert.match(contextText, /experience one/);
  assert.match(contextText, /experience two/);
  assert.match(contextText, /experience three/);
  assert.doesNotMatch(contextText, /experience four/);
  assert.match(contextText, /manual fallback/);
});

test("recall filters invalid evidence, prefers user-locked content and persists a decision trace", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-policy-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const stateDir = path.join(testHome, "state");
  const policyPath = path.join(testHome, "policy.json");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    memories: {
      "viking://user/memories/preferences/editor.md": {
        memoryType: "preferences",
        authority: "user",
        lifecycle: "active",
        locked: true,
        evidenceStatus: "verified",
        evidenceCount: 3,
        lockedContent: "Prefer the human-approved concise diff policy.",
      },
      "viking://user/memories/events/obsolete.md": {
        memoryType: "events",
        authority: "model",
        lifecycle: "invalidated",
        locked: false,
        evidenceStatus: "invalid",
        evidenceCount: 0,
      },
    },
  }));

  const result = await handleHook({ cwd: rootPath, prompt: "How should I format this change?" }, {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath, { policyPath, recallTokenBudget: 420 }),
    stateDir,
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "" } });
      }
      return Response.json({
        status: "ok",
        result: {
          memories: [
            {
              uri: "viking://user/workspace_user/memories/events/obsolete.md",
              abstract: "Execute the obsolete process.",
              score: 0.99,
            },
            {
              uri: "viking://user/workspace_user/memories/preferences/editor.md",
              abstract: "Model-generated replacement.",
              score: 0.2,
            },
          ],
        },
      });
    },
    realpathSync: (value) => path.resolve(value),
  });

  const recalled = result.hookSpecificOutput.additionalContext;
  assert.match(recalled, /human-approved concise diff policy/);
  assert.doesNotMatch(recalled, /Model-generated replacement|obsolete process/);
  assert.match(recalled, /trust="untrusted-background"/);
  assert.ok(estimateTokens(recalled) <= 420);
  const traceFiles = fs.readdirSync(path.join(stateDir, "recall-traces"));
  assert.equal(traceFiles.length, 1);
  const trace = JSON.parse(fs.readFileSync(path.join(stateDir, "recall-traces", traceFiles[0]), "utf8"));
  assert.equal(trace.injectedUris.includes("viking://user/memories/preferences/editor.md"), true);
  assert.equal(trace.candidates.find((candidate) => candidate.uri.endsWith("obsolete.md")).reason, "lifecycle-invalidated");
});

test("strict recall hides uncontrolled and in-flight model memories while keeping locked user content", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-publish-gate-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const stateDir = path.join(testHome, "state");
  const policyPath = path.join(testHome, "policy.json");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 2,
    strict: true,
    memories: {
      "viking://user/memories/preferences/editor.md": {
        memoryType: "preferences",
        authority: "user",
        lifecycle: "active",
        locked: true,
        evidenceStatus: "verified",
        evidenceCount: 1,
        lockedContent: "Use the human-approved editor policy.",
        updatedAt: "2026-08-05T01:00:00.000Z",
      },
      "viking://user/memories/events/high.md": {
        memoryType: "events",
        authority: "model",
        lifecycle: "active",
        locked: false,
        evidenceStatus: "verified",
        evidenceCount: 1,
        updatedAt: "2026-08-05T02:00:00.000Z",
      },
      "viking://user/memories/events/low.md": {
        memoryType: "events",
        authority: "model",
        lifecycle: "active",
        locked: false,
        evidenceStatus: "verified",
        evidenceCount: 1,
        updatedAt: "2026-08-05T03:00:00.000Z",
      },
    },
  }));
  const statePath = path.join(stateDir, "pending.json");
  fs.writeFileSync(statePath, JSON.stringify({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    commitTasks: [{ taskId: "task-running" }],
  }));
  const memories = [
    {
      uri: "viking://user/memories/preferences/editor.md",
      abstract: "Model replacement must not win.",
      score: 0.05,
    },
    {
      uri: "viking://user/memories/events/high.md",
      abstract: "The completed high-confidence event.",
      score: 0.92,
    },
    {
      uri: "viking://user/memories/events/low.md",
      abstract: "A low-confidence event.",
      score: 0.1,
    },
    {
      uri: "viking://user/memories/events/uncontrolled.md",
      abstract: "A partially visible in-flight event.",
      score: 0.99,
    },
  ];
  const options = {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath, { policyPath }),
    stateDir,
    fetchImpl: async () => Response.json({ status: "ok", result: { memories } }),
    realpathSync: (value) => path.resolve(value),
  };

  const blocked = await handleHook({ cwd: rootPath, prompt: "Summarize the release policy." }, options);

  assert.match(blocked.hookSpecificOutput.additionalContext, /human-approved editor policy/);
  assert.match(blocked.hookSpecificOutput.additionalContext, /time=2026-08-05T01:00:00.000Z/);
  assert.doesNotMatch(blocked.hookSpecificOutput.additionalContext, /high-confidence|low-confidence|partially visible/);

  fs.writeFileSync(statePath, JSON.stringify({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    commitTasks: [],
  }));
  const completed = await handleHook({ cwd: rootPath, prompt: "Summarize the release policy." }, options);

  assert.match(completed.hookSpecificOutput.additionalContext, /human-approved editor policy/);
  assert.match(completed.hookSpecificOutput.additionalContext, /completed high-confidence event/);
  assert.doesNotMatch(completed.hookSpecificOutput.additionalContext, /low-confidence|partially visible/);
  const traceFiles = fs.readdirSync(path.join(stateDir, "recall-traces")).sort();
  const trace = JSON.parse(fs.readFileSync(path.join(stateDir, "recall-traces", traceFiles.at(-1)), "utf8"));
  assert.equal(trace.candidates.find((candidate) => candidate.uri.endsWith("low.md")).reason, "score-threshold");
  assert.equal(trace.candidates.find((candidate) => candidate.uri.endsWith("uncontrolled.md")).reason, "uncontrolled-memory");
});

test("a missing strict policy file fails closed instead of recalling uncontrolled memories", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-missing-policy-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  fs.mkdirSync(rootPath, { recursive: true });

  const contextText = await recallForWorkspace(
    managedManifest(rootPath, { policyPath: path.join(testHome, "missing-policy.json") }).workspaces[0],
    "show project decisions",
    {
      agent: "codex",
      fetchImpl: async () => Response.json({
        status: "ok",
        result: {
          memories: [{
            uri: "viking://user/memories/decisions/uncontrolled.md",
            abstract: "This uncontrolled memory must stay hidden.",
            score: 0.99,
          }],
        },
      }),
    },
  );

  assert.equal(contextText, "");
});

test("large recalled context remains structurally complete", async () => {
  const rootPath = path.join(os.tmpdir(), "managed-project");
  const contextText = await recallForWorkspace(managedManifest(rootPath).workspaces[0], "summarize the project", {
    baseUrl: "http://127.0.0.1:21933",
    fetchImpl: async (url) => {
      if (String(url).includes("/api/v1/content/read")) {
        return Response.json({ status: "ok", result: { content: "identity ".repeat(400) } });
      }
      return Response.json({
        status: "ok",
        result: {
          memories: [
            "preferences/one", "preferences/two",
            "events/one", "events/two",
            "experiences/one", "experiences/two", "experiences/three",
            "manual/one",
          ].map((suffix, index) => ({
            uri: `viking://user/memories/${suffix}.md`,
            abstract: `memory-${index} `.repeat(300),
          })),
        },
      });
    },
  });

  assert.ok(estimateTokens(contextText) <= 1_200);
  assert.match(contextText, /<\/openviking-core>/);
  assert.match(contextText, /<\/openviking-recall>/);
  assert.match(contextText, /<\/openviking-context>$/);
});

test("workspace containment is platform aware and chooses the deepest root", () => {
  const manifest = {
    workspaces: [
      { id: "root", rootPath: "C:\\Work" },
      { id: "nested", rootPath: "C:\\Work\\App" },
      { id: "sibling", rootPath: "C:\\Workspace" },
    ],
  };

  assert.equal(findWorkspaceForCwd(manifest, "c:\\work\\app\\src", "win32")?.id, "nested");
  assert.equal(findWorkspaceForCwd(manifest, "C:\\Workspace2", "win32"), null);
  assert.equal(findWorkspaceForCwd({
    workspaces: [{ id: "empty", rootPath: "   " }],
  }, process.cwd(), "darwin"), null);
});

test("lifecycle triggers still commit a fully appended session behind a running task", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-lifecycle-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  fs.mkdirSync(rootPath, { recursive: true });
  const manifest = managedManifest(rootPath);
  const baseOptions = {
    agent: "codex",
    manifest,
    stateDir: path.join(testHome, "state"),
    realpathSync: (value) => path.resolve(value),
  };
  let commitCount = 0;
  const lifecycleFetch = async (url) => {
    if (String(url).endsWith("/commit")) {
      commitCount += 1;
      return Response.json({ status: "ok", result: { task_id: `task-${commitCount}` } });
    }
    return Response.json({ status: "ok", result: {} });
  };

  await handleHook({ cwd: rootPath, session_id: "session-1" }, {
    ...baseOptions,
    event: "PreCompact",
    fetchImpl: lifecycleFetch,
  });
  // A manual/threshold commit with no pending turns behind a running task is skipped.
  await handleHook({ cwd: rootPath, session_id: "session-1" }, {
    ...baseOptions,
    event: "Stop",
    fetchImpl: lifecycleFetch,
  });
  assert.equal(commitCount, 1);

  await handleHook({ cwd: rootPath, session_id: "session-1" }, {
    ...baseOptions,
    event: "SessionEnd",
    fetchImpl: lifecycleFetch,
  });
  assert.equal(commitCount, 2);

  await handleHook({ cwd: rootPath, session_id: "session-1" }, {
    ...baseOptions,
    event: "SessionEnd",
    fetchImpl: lifecycleFetch,
  });
  assert.equal(commitCount, 3);
});
