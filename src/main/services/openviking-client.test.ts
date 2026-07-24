import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OpenVikingGateway,
  OpenVikingGatewayError,
  type OpenVikingWorkspaceAuth,
} from "./openviking-client";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

describe("OpenVikingGateway", () => {
  const requests: RecordedRequest[] = [];
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let failure: { path: string; status: number; body: unknown } | undefined;

  beforeEach(async () => {
    requests.length = 0;
    failure = undefined;
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body,
      });
      if (failure?.path === url.pathname) {
        sendJson(response, failure.status, failure.body);
        return;
      }
      route(url, request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  });

  afterEach(async () => {
    await closeServer?.();
  });

  it("checks health and creates an isolated user under the shared AgentRecall account", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });

    await expect(gateway.health()).resolves.toBeUndefined();
    await expect(gateway.ensureWorkspaceUser({
      accountId: "agent-recall",
      userId: "workspace_abcd",
    })).resolves.toEqual({
      accountId: "agent-recall",
      userId: "workspace_abcd",
      apiKey: "workspace-key",
    });

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/health"],
      ["GET", "/api/v1/admin/accounts"],
      ["POST", "/api/v1/admin/accounts"],
    ]);
    expect(requests[1].headers["x-api-key"]).toBe("root-key");
    expect(requests[2].body).toMatchObject({
      account_id: "agent-recall",
      admin_user_id: "workspace_abcd",
    });
  });

  it("registers another workspace user in an existing account", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });
    await gateway.ensureWorkspaceUser({
      accountId: "agent-recall-existing",
      userId: "workspace_new",
    });

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/api/v1/admin/accounts"],
      ["GET", "/api/v1/admin/accounts/agent-recall-existing/users"],
      ["POST", "/api/v1/admin/accounts/agent-recall-existing/users"],
    ]);
    expect(requests[2].body).toMatchObject({
      user_id: "workspace_new",
      role: "member",
    });
  });

  it("regenerates credentials when a previous add already created the workspace user", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });

    await expect(gateway.ensureWorkspaceUser({
      accountId: "agent-recall-existing",
      userId: "workspace_existing",
    })).resolves.toEqual({
      accountId: "agent-recall-existing",
      userId: "workspace_existing",
      apiKey: "regenerated-workspace-key",
    });

    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/api/v1/admin/accounts"],
      ["GET", "/api/v1/admin/accounts/agent-recall-existing/users"],
      ["POST", "/api/v1/admin/accounts/agent-recall-existing/users/workspace_existing/key"],
    ]);
  });

  it("appends and commits sessions using only the workspace user's credentials", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });
    const auth: OpenVikingWorkspaceAuth = {
      accountId: "agent-recall",
      userId: "workspace_abcd",
      apiKey: "workspace-key",
    };

    await gateway.appendMessages(auth, "session-1", [
      { role: "user", content: "question", createdAt: "2026-07-24T00:00:00.000Z" },
      { role: "assistant", content: "answer" },
    ]);
    await expect(gateway.commitSession(auth, "session-1")).resolves.toEqual({
      taskId: "task-1",
    });
    await expect(gateway.getTask(auth, "task-1")).resolves.toMatchObject({
      id: "task-1",
      status: "completed",
    });

    const userRequests = requests.filter((request) => request.path.includes("session") || request.path.includes("tasks"));
    expect(userRequests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/api/v1/sessions/session-1?auto_create=true"],
      ["POST", "/api/v1/sessions/session-1/messages/batch"],
      ["POST", "/api/v1/sessions/session-1/commit"],
      ["GET", "/api/v1/tasks/task-1"],
    ]);
    for (const request of userRequests) {
      expect(request.headers["x-api-key"]).toBe("workspace-key");
      expect(request.headers["x-openviking-account"]).toBe("agent-recall");
      expect(request.headers["x-openviking-user"]).toBe("workspace_abcd");
    }
  });

  it("normalizes memory search, read, write and delete operations", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });
    const auth: OpenVikingWorkspaceAuth = {
      accountId: "agent-recall",
      userId: "workspace_abcd",
      apiKey: "workspace-key",
    };

    await expect(gateway.searchMemories(auth, "database migration", 5)).resolves.toEqual([{
      id: "viking://user/memories/memory-1.md",
      workspaceId: "",
      title: "Migration decision",
      content: "Use migration 4",
      source: "session-1",
      score: 0.91,
    }]);
    await expect(gateway.readMemory(auth, "viking://user/memories/memory-1.md")).resolves.toBe(
      "Use migration 4",
    );
    const saved = await gateway.saveMemory(auth, {
      id: "manual-1",
      title: "Manual note",
      content: "Keep directory isolation",
    });
    expect(saved.id).toBe("viking://user/memories/manual/manual-1.md");
    await gateway.deleteMemory(auth, saved.id);
  });

  it("turns SDK failures into stable retryable gateway errors", async () => {
    failure = {
      path: "/api/v1/search/find",
      status: 503,
      body: {
        status: "error",
        error: { code: "QUEUE_UNAVAILABLE", message: "queue offline" },
      },
    };
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });

    const error = await gateway.searchMemories({
      accountId: "agent-recall",
      userId: "workspace_abcd",
      apiKey: "workspace-key",
    }, "query").catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenVikingGatewayError);
    expect(error).toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      statusCode: 503,
      retryable: true,
      message: "queue offline",
    });
  });

  it("removes workspace user data through the root administration client", async () => {
    const gateway = new OpenVikingGateway({ baseUrl, rootApiKey: "root-key" });

    await gateway.deleteWorkspaceUser("agent-recall", "workspace_abcd");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "DELETE",
      path: "/api/v1/admin/accounts/agent-recall/users/workspace_abcd",
    });
    expect(requests[0].headers["x-api-key"]).toBe("root-key");
  });

  function route(url: URL, request: IncomingMessage, response: ServerResponse): void {
    if (url.pathname === "/health") return sendJson(response, 200, { status: "ok" });
    if (url.pathname === "/api/v1/admin/accounts" && request.method === "GET") {
      return sendJson(response, 200, {
        status: "ok",
        result: [{ account_id: "agent-recall-existing" }],
      });
    }
    if (url.pathname === "/api/v1/admin/accounts" && request.method === "POST") {
      const body = requests.at(-1)?.body as { account_id?: string };
      if (body?.account_id === "agent-recall-existing") {
        return sendJson(response, 409, {
          status: "error",
          error: { code: "ALREADY_EXISTS", message: "exists" },
        });
      }
      return sendJson(response, 200, {
        status: "ok",
        result: { user_key: "workspace-key" },
      });
    }
    if (url.pathname === "/api/v1/admin/accounts/agent-recall-existing/users" && request.method === "GET") {
      return sendJson(response, 200, {
        status: "ok",
        result: [{ user_id: "workspace_existing" }],
      });
    }
    if (url.pathname === "/api/v1/admin/accounts/agent-recall-existing/users" && request.method === "POST") {
      return sendJson(response, 200, {
        status: "ok",
        result: { user_key: "workspace-key" },
      });
    }
    if (
      url.pathname === "/api/v1/admin/accounts/agent-recall-existing/users/workspace_existing/key"
      && request.method === "POST"
    ) {
      return sendJson(response, 200, {
        status: "ok",
        result: { user_key: "regenerated-workspace-key" },
      });
    }
    if (url.pathname === "/api/v1/admin/accounts/agent-recall/users/workspace_abcd" && request.method === "DELETE") {
      return sendJson(response, 200, { status: "ok", result: {} });
    }
    if (url.pathname === "/api/v1/sessions/session-1" && request.method === "GET") {
      return sendJson(response, 200, { status: "ok", result: { session_id: "session-1" } });
    }
    if (url.pathname.endsWith("/messages/batch")) {
      return sendJson(response, 200, { status: "ok", result: { accepted: 2 } });
    }
    if (url.pathname.endsWith("/commit")) {
      return sendJson(response, 200, { status: "ok", result: { task_id: "task-1" } });
    }
    if (url.pathname === "/api/v1/tasks/task-1") {
      return sendJson(response, 200, {
        status: "ok",
        result: { id: "task-1", status: "completed" },
      });
    }
    if (url.pathname === "/api/v1/search/find") {
      return sendJson(response, 200, {
        status: "ok",
        result: {
          memories: [{
            uri: "viking://user/memories/memory-1.md",
            title: "Migration decision",
            content: "Use migration 4",
            source: "session-1",
            score: 0.91,
          }],
        },
      });
    }
    if (url.pathname === "/api/v1/content/read") {
      return sendJson(response, 200, { status: "ok", result: "Use migration 4" });
    }
    if (url.pathname === "/api/v1/content/write") {
      return sendJson(response, 200, { status: "ok", result: { task_id: "write-1" } });
    }
    if (url.pathname === "/api/v1/fs" && request.method === "DELETE") {
      return sendJson(response, 200, { status: "ok", result: null });
    }
    sendJson(response, 404, {
      status: "error",
      error: { code: "NOT_FOUND", message: `${request.method} ${url.pathname}` },
    });
  }
});

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
