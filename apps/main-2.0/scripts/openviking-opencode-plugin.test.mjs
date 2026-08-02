import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentRecallOpenVikingPlugin } from "../bin/openviking-opencode-plugin.mjs";

test("OpenCode recalls before a managed prompt and captures the completed turn", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-opencode-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    baseUrl: "http://127.0.0.1:21933",
    stateDir: path.join(root, "state"),
    integrations: { claude: false, codex: false, opencode: true },
    workspaces: [{
      id: "workspace-1",
      rootPath: fs.realpathSync.native(project),
      accountId: "agent-recall-v2",
      userId: "workspace_user",
      apiKey: "workspace-key",
    }],
  }));
  const requests = [];
  const plugin = createAgentRecallOpenVikingPlugin(manifestPath, {
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/search/search")) {
        return Response.json({ status: "ok", result: { memories: [{ abstract: "Keep release notes concise." }] } });
      }
      if (String(url).includes("/api/v1/content/read")) return Response.json({ status: "ok", result: { content: "" } });
      return Response.json({ status: "ok", result: {} });
    },
  });
  const hooks = await plugin({ directory: project });
  const output = { parts: [{ type: "text", text: "What was our release note rule?" }] };

  await hooks["chat.message"]({ sessionID: "session-1" }, output);
  assert.match(output.parts[0].text, /Keep release notes concise/);
  await hooks.event({ event: { type: "message.updated", properties: { info: { id: "assistant-message", sessionID: "session-1", role: "assistant" } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { messageID: "assistant-message", sessionID: "session-1", type: "text", text: "Use one clear user-facing bullet." } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

  assert.equal(requests.filter((request) => request.url.endsWith("/api/v1/search/search")).length, 1);
  const search = requests.find((request) => request.url.endsWith("/api/v1/search/search"));
  assert.match(JSON.parse(search.init.body).session_id, /^opencode-workspace-1-session-1$/);
  assert.equal(requests.filter((request) => request.url.endsWith("/messages/batch")).length, 1);
  const batch = requests.find((request) => request.url.endsWith("/messages/batch"));
  assert.deepEqual(JSON.parse(batch.init.body).messages.map((message) => message.role), ["user", "assistant"]);

  const nextOutput = { parts: [{ type: "text", text: "Continue with that approach." }] };
  await hooks["chat.message"]({ sessionID: "session-1" }, nextOutput);
  const nextSearch = requests.filter((request) => request.url.endsWith("/api/v1/search/search")).at(-1);
  const nextQuery = JSON.parse(nextSearch.init.body).query;
  assert.match(nextQuery, /What was our release note rule/);
  assert.match(nextQuery, /Use one clear user-facing bullet/);
});
