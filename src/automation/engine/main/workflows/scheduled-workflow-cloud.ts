import {
  DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY,
  DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
  type AckScheduledWorkflowEventRequest,
  type CreateScheduledWorkflowScheduleRequest,
  type RegisterScheduledWorkflowRunnerRequest,
  type ScheduledWorkflowDueEvent,
  type ScheduledWorkflowFrequency,
  type ScheduledWorkflowRunnerConfig,
  type ScheduledWorkflowSchedule,
  type UpdateScheduledWorkflowScheduleRequest,
} from "../../shared/types";

export interface ScheduledWorkflowCloudEventConnection {
  close: () => void;
}

interface CloudScheduleRecord {
  id?: unknown;
  scheduleId?: unknown;
  workflowId?: unknown;
  title?: unknown;
  enabled?: unknown;
  intervalSeconds?: unknown;
  frequency?: unknown;
  scheduleType?: unknown;
  timeOfDay?: unknown;
  timezone?: unknown;
  weekdays?: unknown;
  dayOfMonth?: unknown;
  nextRunAt?: unknown;
  lastRunAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeFrequency(value: unknown): ScheduledWorkflowFrequency {
  return value === "weekly" || value === "monthly" ? value : "daily";
}

function normalizeTimeOfDay(value: unknown): string {
  const raw = asString(value)?.trim();
  return raw && /^\d{2}:\d{2}$/.test(raw) ? raw : DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY;
}

function normalizeWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = [...new Set(value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6))];
  return days.length > 0 ? days : undefined;
}

function normalizeDayOfMonth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return Math.min(31, Math.max(1, value));
}

function normalizeSchedule(raw: unknown): ScheduledWorkflowSchedule {
  const record = (asRecord(raw) ?? {}) as CloudScheduleRecord;
  const scheduleId = asString(record.scheduleId) ?? asString(record.id);
  const workflowId = asString(record.workflowId);
  if (!scheduleId) throw new Error("Cloud schedule is missing id.");
  if (!workflowId) throw new Error(`Cloud schedule ${scheduleId} is missing workflowId.`);
  return {
    scheduleId,
    workflowId,
    title: asString(record.title) ?? "Scheduled workflow",
    enabled: record.enabled !== false,
    intervalSeconds: Math.max(60, Math.floor(asNumber(record.intervalSeconds, 3600))),
    frequency: normalizeFrequency(record.frequency ?? record.scheduleType),
    timeOfDay: normalizeTimeOfDay(record.timeOfDay),
    timezone: asString(record.timezone)?.trim() || DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
    ...(normalizeWeekdays(record.weekdays) !== undefined ? { weekdays: normalizeWeekdays(record.weekdays) } : {}),
    ...(normalizeDayOfMonth(record.dayOfMonth) !== undefined ? { dayOfMonth: normalizeDayOfMonth(record.dayOfMonth) } : {}),
    ...(optionalNumber(record.nextRunAt) !== undefined ? { nextRunAt: optionalNumber(record.nextRunAt) } : {}),
    ...(optionalNumber(record.lastRunAt) !== undefined ? { lastRunAt: optionalNumber(record.lastRunAt) } : {}),
    source: "cloud",
    createdAt: asNumber(record.createdAt, Date.now()),
    updatedAt: asNumber(record.updatedAt, Date.now()),
  };
}

function normalizeEvent(raw: unknown): ScheduledWorkflowDueEvent {
  const record = asRecord(raw) ?? {};
  const eventId = asString(record.eventId) ?? asString(record.id);
  if (!eventId) throw new Error("Cloud event is missing id.");
  return {
    eventId,
    type: asString(record.type) ?? "workflow_due",
    title: asString(record.title) ?? "Scheduled workflow",
    message: asString(record.message) ?? "",
    payload: asRecord(record.payload) ?? {},
  };
}

export class ScheduledWorkflowCloudClient {
  async registerRunner(config: RegisterScheduledWorkflowRunnerRequest): Promise<ScheduledWorkflowRunnerConfig> {
    const baseUrl = cleanBaseUrl(config.baseUrl);
    if (!baseUrl) throw new Error("Cloud base URL is required.");
    const tenantId = config.tenantId?.trim();
    const userId = config.userId?.trim();
    const deviceName = config.deviceName?.trim();
    if (!tenantId || !userId || !deviceName) throw new Error("tenantId, userId, and deviceName are required.");

    const response = await fetch(`${baseUrl}/api/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId, userId, deviceName }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cloud runner registration failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`);
    }

    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : {};
    const record = asRecord(payload) ?? {};
    const deviceId = asString(record.deviceId);
    const runnerToken = asString(record.runnerToken);
    if (!deviceId) throw new Error("Cloud runner registration is missing deviceId.");
    if (!runnerToken) throw new Error("Cloud runner registration is missing runnerToken.");

    return {
      baseUrl,
      tenantId: asString(record.tenantId) ?? tenantId,
      userId: asString(record.userId) ?? userId,
      deviceName: asString(record.deviceName) ?? deviceName,
      deviceId,
      runnerToken,
    };
  }

  connectEvents(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    handlers: {
      onEvent: (event: ScheduledWorkflowDueEvent) => void;
      onError?: (error: Error) => void;
    },
  ): ScheduledWorkflowCloudEventConnection {
    const controller = new AbortController();
    void this.readEventStream(config, controller.signal, handlers).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      close: () => controller.abort(),
    };
  }

  async listSchedules(config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">): Promise<ScheduledWorkflowSchedule[]> {
    const payload = await this.request(config, "/api/runner/schedules");
    const payloadRecord = asRecord(payload);
    const schedules = Array.isArray(payloadRecord?.schedules) ? payloadRecord.schedules : [];
    return schedules.map((item) => normalizeSchedule(item));
  }

  async createSchedule(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    request: CreateScheduledWorkflowScheduleRequest,
  ): Promise<ScheduledWorkflowSchedule> {
    const payload = await this.request(config, "/api/runner/schedules", { method: "POST", body: request });
    return normalizeSchedule(asRecord(payload)?.schedule ?? payload);
  }

  async updateSchedule(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    scheduleId: string,
    request: UpdateScheduledWorkflowScheduleRequest,
  ): Promise<ScheduledWorkflowSchedule> {
    const payload = await this.request(config, `/api/runner/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: request });
    return normalizeSchedule(asRecord(payload)?.schedule ?? payload);
  }

  async deleteSchedule(config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">, scheduleId: string): Promise<void> {
    await this.request(config, `/api/runner/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
  }

  async triggerSchedule(config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">, scheduleId: string): Promise<ScheduledWorkflowDueEvent> {
    const payload = await this.request(config, `/api/runner/schedules/${encodeURIComponent(scheduleId)}/trigger`, { method: "POST" });
    return normalizeEvent(asRecord(payload)?.event ?? payload);
  }

  async ackEvent(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    eventId: string,
    result: AckScheduledWorkflowEventRequest,
  ): Promise<void> {
    await this.request(config, `/api/runner/events/${encodeURIComponent(eventId)}/ack`, { method: "POST", body: result });
  }

  private async readEventStream(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    signal: AbortSignal,
    handlers: {
      onEvent: (event: ScheduledWorkflowDueEvent) => void;
      onError?: (error: Error) => void;
    },
  ): Promise<void> {
    const baseUrl = cleanBaseUrl(config.baseUrl);
    if (!baseUrl) throw new Error("Cloud base URL is required.");
    if (!config.runnerToken?.trim()) throw new Error("Runner token is required.");

    const response = await fetch(`${baseUrl}/api/runner/events`, {
      headers: { authorization: `Bearer ${config.runnerToken.trim()}` },
      signal,
    });
    if (!response.ok) throw new Error(`Cloud event stream failed: ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("Cloud event stream did not include a response body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let eventId = "";
    let dataLines: string[] = [];

    const dispatch = (): void => {
      if (dataLines.length === 0) {
        eventType = "";
        eventId = "";
        return;
      }
      const rawData = dataLines.join("\n");
      dataLines = [];
      try {
        const parsed = JSON.parse(rawData) as unknown;
        const record = asRecord(parsed) ?? {};
        handlers.onEvent(normalizeEvent({
          ...record,
          id: asString(record.id) ?? asString(record.eventId) ?? eventId,
          type: asString(record.type) ?? (eventType || "workflow_due"),
        }));
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        eventType = "";
        eventId = "";
      }
    };

    const processLine = (line: string): void => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (normalized === "") {
        dispatch();
        return;
      }
      if (normalized.startsWith(":")) return;
      const separatorIndex = normalized.indexOf(":");
      const field = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
      const rawValue = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventType = value;
      if (field === "id") eventId = value;
      if (field === "data") dataLines.push(value);
    };

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) processLine(buffer);
    dispatch();
  }

  private async request(
    config: Pick<ScheduledWorkflowRunnerConfig, "baseUrl" | "runnerToken">,
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const baseUrl = cleanBaseUrl(config.baseUrl);
    if (!baseUrl) throw new Error("Cloud base URL is required.");
    if (!config.runnerToken?.trim()) throw new Error("Runner token is required.");

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.runnerToken.trim()}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cloud request failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
}
