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
} = require("../bin/openviking-memory-hook.cjs");

function managedManifest(rootPath) {
  return {
    version: 1,
    baseUrl: "http://127.0.0.1:21933",
    integrations: { claude: true, codex: true, opencode: true },
    workspaces: [{
      id: "workspace-1",
      rootPath,
      accountId: "agent-recall",
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

test("managed prompt recall is scoped to the workspace user", async () => {
  const rootPath = path.join(os.tmpdir(), "managed-project");
  const requests = [];
  const result = await handleHook({ cwd: rootPath, prompt: "How did we migrate the database?" }, {
    agent: "codex",
    event: "UserPromptSubmit",
    manifest: managedManifest(rootPath),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
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

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:21933/api/v1/search/find");
  assert.equal(requests[0].init.headers["X-API-Key"], "workspace-key");
  assert.equal(requests[0].init.headers["X-OpenViking-User"], "workspace_user");
  assert.match(result.hookSpecificOutput.additionalContext, /staged migration plan/);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("managed Stop captures the latest transcript turn and commits it once", async (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-hook-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const rootPath = path.join(testHome, "project");
  const transcriptPath = path.join(testHome, "transcript.jsonl");
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: "user", content: "Remember the release checklist." } }),
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
  assert.equal(requests.filter((request) => request.url.endsWith("/commit")).length, 1);
  const batch = requests.find((request) => request.url.endsWith("/messages/batch"));
  assert.deepEqual(JSON.parse(batch.init.body).messages.map((message) => message.role), ["user", "assistant"]);
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
