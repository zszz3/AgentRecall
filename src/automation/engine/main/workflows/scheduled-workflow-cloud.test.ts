import http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { ScheduledWorkflowCloudClient } from "./scheduled-workflow-cloud";

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ScheduledWorkflowCloudClient", () => {
  test("registers a local runner device without requiring user-entered credentials", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined; admin: string | undefined; body: unknown }> = [];
    const server = await startServer(async (request, response) => {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, admin: request.headers["x-admin-token"] as string | undefined, body });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/api/devices/register") {
        response.statusCode = 201;
        response.end(JSON.stringify({
          deviceId: "dev_local",
          tenantId: "tenant_local",
          userId: "user_local",
          deviceName: "Local Mac",
          runnerToken: "runner-token",
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const client = new ScheduledWorkflowCloudClient();
    const registered = await client.registerRunner({
      baseUrl: server.baseUrl,
      tenantId: "tenant_local",
      userId: "user_local",
      deviceName: "Local Mac",
    });

    expect(registered).toEqual({
      baseUrl: server.baseUrl,
      tenantId: "tenant_local",
      userId: "user_local",
      deviceName: "Local Mac",
      deviceId: "dev_local",
      runnerToken: "runner-token",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/devices/register",
        auth: undefined,
        admin: undefined,
        body: { tenantId: "tenant_local", userId: "user_local", deviceName: "Local Mac" },
      },
    ]);

    await server.close();
  });

  test("maps runner schedule CRUD and event ack requests", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = await startServer(async (request, response) => {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");

      if (request.method === "GET" && request.url === "/api/runner/schedules") {
        response.end(JSON.stringify({
          schedules: [
            {
              id: "sched_1",
              workflowId: "wf_1",
              title: "Morning workflow",
              enabled: true,
              intervalSeconds: 3600,
              frequency: "daily",
              timeOfDay: "09:00",
              timezone: "Asia/Shanghai",
              nextRunAt: 1710003600000,
              lastRunAt: null,
              createdAt: 1710000000000,
              updatedAt: 1710000000000,
            },
          ],
        }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runner/schedules") {
        response.end(JSON.stringify({
          schedule: {
            id: "sched_2",
            workflowId: "wf_2",
            title: "Created workflow",
            enabled: true,
            intervalSeconds: 86400,
            frequency: "weekly",
            timeOfDay: "10:30",
            timezone: "Asia/Shanghai",
            weekdays: [1],
            nextRunAt: 1710007200000,
            createdAt: 1710000100000,
            updatedAt: 1710000100000,
          },
        }));
        return;
      }

      if (request.method === "PATCH" && request.url === "/api/runner/schedules/sched_2") {
        response.end(JSON.stringify({
          schedule: {
            id: "sched_2",
            workflowId: "wf_2",
            title: "Paused workflow",
            enabled: false,
            intervalSeconds: 86400,
            frequency: "weekly",
            timeOfDay: "10:30",
            timezone: "Asia/Shanghai",
            weekdays: [1],
            nextRunAt: 1710007200000,
            createdAt: 1710000100000,
            updatedAt: 1710000200000,
          },
        }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runner/schedules/sched_2/trigger") {
        response.end(JSON.stringify({
          event: {
            id: "event_1",
            type: "workflow_due",
            title: "Paused workflow",
            message: "Manual trigger",
            payload: { scheduleId: "sched_2", workflowId: "wf_2" },
          },
        }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runner/events/event_1/ack") {
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === "DELETE" && request.url === "/api/runner/schedules/sched_2") {
        response.statusCode = 204;
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const client = new ScheduledWorkflowCloudClient();
    const config = { baseUrl: server.baseUrl, runnerToken: "runner-token" };

    const schedules = await client.listSchedules(config);
    expect(schedules).toEqual([
      {
        scheduleId: "sched_1",
        workflowId: "wf_1",
        title: "Morning workflow",
        enabled: true,
        intervalSeconds: 3600,
        frequency: "daily",
        timeOfDay: "09:00",
        timezone: "Asia/Shanghai",
        nextRunAt: 1710003600000,
        source: "cloud",
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
      },
    ]);

    const created = await client.createSchedule(config, {
      workflowId: "wf_2",
      title: "Created workflow",
      enabled: true,
      frequency: "weekly",
      timeOfDay: "10:30",
      timezone: "Asia/Shanghai",
      weekdays: [1],
    });
    expect(created).toMatchObject({ scheduleId: "sched_2", workflowId: "wf_2", frequency: "weekly", timeOfDay: "10:30", weekdays: [1] });

    const updated = await client.updateSchedule(config, "sched_2", { enabled: false, title: "Paused workflow" });
    expect(updated).toMatchObject({ scheduleId: "sched_2", enabled: false, title: "Paused workflow" });

    const event = await client.triggerSchedule(config, "sched_2");
    expect(event).toMatchObject({
      eventId: "event_1",
      type: "workflow_due",
      payload: { scheduleId: "sched_2", workflowId: "wf_2" },
    });

    await client.ackEvent(config, "event_1", { status: "completed", workflowRunId: "run_1", message: "Done" });
    await client.deleteSchedule(config, "sched_2");

    expect(requests.map((request) => [request.method, request.url, request.auth])).toEqual([
      ["GET", "/api/runner/schedules", "Bearer runner-token"],
      ["POST", "/api/runner/schedules", "Bearer runner-token"],
      ["PATCH", "/api/runner/schedules/sched_2", "Bearer runner-token"],
      ["POST", "/api/runner/schedules/sched_2/trigger", "Bearer runner-token"],
      ["POST", "/api/runner/events/event_1/ack", "Bearer runner-token"],
      ["DELETE", "/api/runner/schedules/sched_2", "Bearer runner-token"],
    ]);
    expect(requests[1]?.body).toMatchObject({ workflowId: "wf_2", title: "Created workflow", frequency: "weekly", timeOfDay: "10:30", timezone: "Asia/Shanghai", weekdays: [1] });
    expect(requests[4]?.body).toMatchObject({ status: "completed", workflowRunId: "run_1", message: "Done" });

    await server.close();
  });

  test("parses runner SSE workflow events", async () => {
    const server = await startServer(async (request, response) => {
      if (request.method !== "GET" || request.url !== "/api/runner/events") {
        response.statusCode = 404;
        response.end();
        return;
      }
      expect(request.headers.authorization).toBe("Bearer runner-token");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write("event: workflow_due\n");
      response.write("id: event_sse_1\n");
      response.write('data: {"title":"SSE workflow","message":"Due now","payload":{"scheduleId":"sched_1","workflowId":"wf_1"}}\n\n');
    });

    const client = new ScheduledWorkflowCloudClient();
    const received = await new Promise((resolve, reject) => {
      const connection = client.connectEvents(
        { baseUrl: server.baseUrl, runnerToken: "runner-token" },
        {
          onEvent: (event) => {
            connection.close();
            resolve(event);
          },
          onError: reject,
        },
      );
    });

    expect(received).toMatchObject({
      eventId: "event_sse_1",
      type: "workflow_due",
      title: "SSE workflow",
      payload: { scheduleId: "sched_1", workflowId: "wf_1" },
    });

    await server.close();
  });
});
