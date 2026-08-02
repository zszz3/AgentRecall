import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  findWorkspaceForCwd,
  handleHook,
  recallForWorkspace,
} = require("../bin/openviking-memory-hook.cjs");

function managedManifest(rootPath) {
  return {
    version: 1,
    baseUrl: "http://127.0.0.1:21933",
    integrations: { claude: true, codex: true, opencode: true },
    workspaces: [{
      id: "workspace-1",
      rootPath,
      accountId: "agent-recall-v2",
      userId: "workspace_user",
      apiKey: "workspace-key",
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
          memories: [{
            uri: "viking://user/memories/events/migration.md",
            abstract: "Use the staged migration plan.",
            score: 0.91,
          }],
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

  assert.ok(contextText.length <= 6_000);
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
});
