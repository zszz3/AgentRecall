import { randomUUID } from "node:crypto";
import http from "node:http";
import type {
  GatewayAgentId,
  GatewayProviderProtocol,
  GatewayRequestRecord,
  GatewayStatus,
} from "../shared/ipc/model-gateway";
import {
  anthropicResponseToOpenAiChat,
  anthropicResponseToResponses,
  emptyGatewayTelemetry,
  extractTelemetryFromNonStreaming,
  openAiChatResponseToAnthropic,
  openAiChatResponseToResponses,
  openAiResponsesToAnthropic,
  openAiResponsesToOpenAiChat,
  pipeAnthropicSseAsOpenAiChat,
  pipeAnthropicSseAsResponses,
  pipeOpenAiChatSseAsAnthropic,
  pipeOpenAiChatSseAsResponses,
  pipePassthroughSse,
  pipeResponsesSseAsAnthropic,
  pipeResponsesSseAsOpenAiChat,
  translateRequestBody,
  type GatewayTelemetry,
} from "./gateway-protocol";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const KNOWN_AGENT_IDS = new Set<string>(["claude-code", "codex", "deepseek-harness", "pi", "opencode"]);

export interface ResolvedGatewayRoute {
  providerId: string;
  providerName: string;
  protocol: GatewayProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GatewayLiveEvent {
  phase: "start" | "complete" | "error";
  requestId: string;
  agentId: GatewayAgentId | "external";
  sessionId: string | null;
  model: string;
  summary?: string;
  hasToolCall?: boolean;
  tokens?: { input: number; output: number; cached: number } | null;
  timestamp: number;
}

export interface LocalModelGatewayOptions {
  host?: string;
  port: number;
  localToken: string;
  resolveRoutes(input: { agentId: GatewayAgentId | "external"; requestedModel: string }): Promise<ResolvedGatewayRoute[]>;
  listModels(): Promise<Array<{ id: string; ownedBy: string }>>;
  onRequestRecord?(record: GatewayRequestRecord): void;
  onLiveEvent?(event: GatewayLiveEvent): void;
  onIslandHookEvent?(payload: unknown): Promise<void>;
  fetchImpl?: typeof fetch;
}

export class LocalModelGateway {
  private server: http.Server | null = null;
  private boundPort: number;
  private startedAt: number | null = null;
  private totalRequests = 0;
  private readonly activeUpstreams = new Set<AbortController>();

  constructor(private readonly options: LocalModelGatewayOptions) {
    this.boundPort = options.port;
  }

  async start(): Promise<GatewayStatus> {
    if (this.server) return this.getStatus();
    const host = this.options.host ?? "127.0.0.1";
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      server.close();
      throw new Error("Local model gateway did not bind to a TCP port.");
    }
    this.server = server;
    this.boundPort = addr.port;
    this.startedAt = Date.now();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startedAt = null;
    for (const controller of this.activeUpstreams) controller.abort();
    if (!server) return;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }

  getStatus(error: string | null = null): GatewayStatus {
    const host = this.options.host ?? "127.0.0.1";
    const running = this.server !== null;
    return {
      running,
      host,
      port: this.boundPort,
      baseUrl: `http://${host}:${this.boundPort}`,
      localToken: this.options.localToken,
      error,
      startedAt: this.startedAt,
      totalRequests: this.totalRequests,
      activeRequests: this.activeUpstreams.size,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url ?? "/").split("?")[0] || "/";
    if (req.method === "GET" && urlPath === "/health") {
      writeJson(res, 200, { ok: true, status: this.getStatus() });
      return;
    }

    if (req.method === "POST" && urlPath === "/island/event") {
      if (!this.isAuthorizedHook(req)) {
        writeJson(res, 401, { error: { message: "Unauthorized gateway token." } });
        return;
      }
      try {
        const raw = await readJsonBody(req);
        await this.options.onIslandHookEvent?.(raw);
        writeJson(res, 200, { ok: true });
      } catch (error) {
        writeJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const parsedRoute = parseIncomingRoute(urlPath, req.headers);
    if (req.method === "GET" && parsedRoute.kind === "models") {
      const models = await this.options.listModels();
      writeJson(res, 200, {
        object: "list",
        data: models.map((item) => ({
          id: item.id,
          object: "model",
          created: Math.floor((this.startedAt ?? Date.now()) / 1000),
          owned_by: item.ownedBy,
        })),
      });
      return;
    }

    if (req.method !== "POST" || parsedRoute.kind !== "inference") {
      writeJson(res, 404, { error: { message: `Unsupported local gateway route: ${urlPath}` } });
      return;
    }

    const startedMs = Date.now();
    const requestId = `gw-${randomUUID().slice(0, 10)}`;
    this.totalRequests += 1;

    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(req);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        writeJson(res, 400, { error: { message: "Request body must be a JSON object." } });
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      writeJson(res, error instanceof BodyTooLargeError ? 413 : 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    const requestedModel = typeof body.model === "string" ? body.model : "";
    const sessionId = extractSessionId(req.headers);
    const routes = await this.options.resolveRoutes({
      agentId: parsedRoute.agentId,
      requestedModel,
    });

    if (routes.length === 0) {
      const message = "AgentRecall 本地网关尚未配置上游 Provider 或默认模型。请在「网关」页添加 Provider 并设置默认路由。";
      this.options.onRequestRecord?.({
        id: requestId,
        timestamp: startedMs,
        agentId: parsedRoute.agentId,
        sessionId,
        incomingFormat: parsedRoute.protocol,
        requestedModel: requestedModel || "(default)",
        upstreamProviderName: "—",
        upstreamModel: "—",
        fallbackUsed: false,
        statusCode: 503,
        ttftMs: null,
        durationMs: Date.now() - startedMs,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        stopReason: null,
        error: message,
      });
      writeJson(res, 503, { error: { message } });
      return;
    }

    this.options.onLiveEvent?.({
      phase: "start",
      requestId,
      agentId: parsedRoute.agentId,
      sessionId,
      model: routes[0]!.model,
      timestamp: startedMs,
    });

    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfIncomplete = () => { if (!res.writableEnded) controller.abort(); };
    req.once("aborted", abort);
    res.once("close", abortIfIncomplete);
    this.activeUpstreams.add(controller);

    let lastStatus = 502;
    let lastError = "Upstream request failed.";
    let lastRoute = routes[0]!;
    let ttftMs: number | null = null;
    let telemetry: GatewayTelemetry = emptyGatewayTelemetry();

    try {
      for (let index = 0; index < routes.length; index++) {
        const route = routes[index]!;
        lastRoute = route;
        const fallbackUsed = index > 0;
        const translated = translateRequestBody(parsedRoute.protocol, route.protocol, body, route.model);
        const upstreamUrl = buildUpstreamUrl(route.baseUrl, translated.pathSuffix);

        let upstreamResponse: Response;
        try {
          upstreamResponse = await (this.options.fetchImpl ?? fetch)(upstreamUrl, {
            method: "POST",
            headers: buildUpstreamHeaders(route),
            body: JSON.stringify(translated.body),
            signal: controller.signal,
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastStatus = 502;
          lastError = redactKey(error instanceof Error ? error.message : String(error), route.apiKey);
          if (index < routes.length - 1) continue;
          break;
        }

        if (!upstreamResponse.ok) {
          const errText = await upstreamResponse.text().catch(() => "");
          lastStatus = upstreamResponse.status || 502;
          lastError = redactKey(errText || `Upstream returned HTTP ${lastStatus}.`, route.apiKey).slice(0, 500);
          // Retry fallback routes on rate limits (429) or transient upstream 5xx errors.
          if ((lastStatus === 429 || lastStatus >= 500) && index < routes.length - 1) {
            continue;
          }
          break;
        }

        const isSse = (upstreamResponse.headers.get("content-type") ?? "").includes("text/event-stream");
        if (isSse && upstreamResponse.body) {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const markTtft = () => {
            if (ttftMs === null) ttftMs = Date.now() - startedMs;
          };
          if (parsedRoute.protocol === route.protocol) {
            telemetry = await pipePassthroughSse(upstreamResponse.body, res, route.protocol, markTtft);
          } else if (parsedRoute.protocol === "anthropic" && route.protocol === "openai_chat") {
            telemetry = await pipeOpenAiChatSseAsAnthropic(upstreamResponse.body, res, route.model, markTtft);
          } else if (parsedRoute.protocol === "anthropic" && route.protocol === "openai_responses") {
            telemetry = await pipeResponsesSseAsAnthropic(upstreamResponse.body, res, route.model, markTtft);
          } else if (parsedRoute.protocol === "openai_chat" && route.protocol === "anthropic") {
            telemetry = await pipeAnthropicSseAsOpenAiChat(upstreamResponse.body, res, route.model, markTtft);
          } else if (parsedRoute.protocol === "openai_chat" && route.protocol === "openai_responses") {
            telemetry = await pipeResponsesSseAsOpenAiChat(upstreamResponse.body, res, route.model, markTtft);
          } else if (parsedRoute.protocol === "openai_responses" && route.protocol === "openai_chat") {
            telemetry = await pipeOpenAiChatSseAsResponses(upstreamResponse.body, res, route.model, markTtft);
          } else {
            telemetry = await pipeAnthropicSseAsResponses(upstreamResponse.body, res, route.model, markTtft);
          }
        } else {
          ttftMs = Date.now() - startedMs;
          const json = await upstreamResponse.json().catch(() => ({})) as Record<string, unknown>;
          let responseBody: Record<string, unknown> = json;
          if (parsedRoute.protocol === route.protocol) {
            telemetry = extractTelemetryFromNonStreaming(route.protocol, json);
          } else if (parsedRoute.protocol === "anthropic" && route.protocol === "openai_chat") {
            const converted = openAiChatResponseToAnthropic(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          } else if (parsedRoute.protocol === "anthropic" && route.protocol === "openai_responses") {
            const converted = openAiResponsesToAnthropic(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          } else if (parsedRoute.protocol === "openai_chat" && route.protocol === "anthropic") {
            const converted = anthropicResponseToOpenAiChat(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          } else if (parsedRoute.protocol === "openai_chat" && route.protocol === "openai_responses") {
            const converted = openAiResponsesToOpenAiChat(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          } else if (parsedRoute.protocol === "openai_responses" && route.protocol === "openai_chat") {
            const converted = openAiChatResponseToResponses(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          } else {
            const converted = anthropicResponseToResponses(json, route.model);
            responseBody = converted.body;
            telemetry = converted.telemetry;
          }
          if (!res.destroyed && !res.writableEnded) {
            writeJson(res, 200, responseBody);
          }
        }

        const durationMs = Date.now() - startedMs;
        this.options.onRequestRecord?.({
          id: requestId,
          timestamp: startedMs,
          agentId: parsedRoute.agentId,
          sessionId,
          incomingFormat: parsedRoute.protocol,
          requestedModel: requestedModel || route.model,
          upstreamProviderName: route.providerName,
          upstreamModel: route.model,
          fallbackUsed,
          statusCode: 200,
          ttftMs,
          durationMs,
          inputTokens: telemetry.inputTokens,
          cachedInputTokens: telemetry.cachedInputTokens,
          outputTokens: telemetry.outputTokens,
          stopReason: telemetry.stopReason,
          error: null,
        });
        this.options.onLiveEvent?.({
          phase: "complete",
          requestId,
          agentId: parsedRoute.agentId,
          sessionId,
          model: route.model,
          summary: telemetry.replyPreview || "模型已回复完成",
          hasToolCall: telemetry.hasToolCall,
          tokens: {
            input: telemetry.inputTokens,
            output: telemetry.outputTokens,
            cached: telemetry.cachedInputTokens,
          },
          timestamp: Date.now(),
        });
        return;
      }

      // All candidate routes failed.
      const durationMs = Date.now() - startedMs;
      this.options.onRequestRecord?.({
        id: requestId,
        timestamp: startedMs,
        agentId: parsedRoute.agentId,
        sessionId,
        incomingFormat: parsedRoute.protocol,
        requestedModel: requestedModel || lastRoute.model,
        upstreamProviderName: lastRoute.providerName,
        upstreamModel: lastRoute.model,
        fallbackUsed: routes.length > 1,
        statusCode: lastStatus,
        ttftMs,
        durationMs,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        stopReason: null,
        error: lastError,
      });
      this.options.onLiveEvent?.({
        phase: "error",
        requestId,
        agentId: parsedRoute.agentId,
        sessionId,
        model: lastRoute.model,
        summary: `HTTP ${lastStatus}: ${lastError.slice(0, 120)}`,
        timestamp: Date.now(),
      });
      if (!res.destroyed && !res.writableEnded && !res.headersSent) {
        writeJson(res, lastStatus, { error: { message: lastError } });
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (!res.destroyed && !res.writableEnded) res.destroy();
        return;
      }
      const message = redactKey(error instanceof Error ? error.message : String(error), lastRoute.apiKey);
      if (!res.destroyed && !res.writableEnded && !res.headersSent) {
        writeJson(res, 500, { error: { message } });
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abortIfIncomplete);
      this.activeUpstreams.delete(controller);
    }
  }

  private isAuthorizedHook(req: http.IncomingMessage): boolean {
    const auth = String(req.headers.authorization ?? "");
    const xKey = String(req.headers["x-api-key"] ?? "");
    return auth === `Bearer ${this.options.localToken}` || xKey === this.options.localToken;
  }
}

function parseIncomingRoute(
  urlPath: string,
  headers: http.IncomingHttpHeaders,
): { kind: "models"; agentId: GatewayAgentId | "external" }
  | { kind: "inference"; agentId: GatewayAgentId | "external"; protocol: GatewayProviderProtocol }
  | { kind: "unknown" } {
  let agentId: GatewayAgentId | "external" = inferAgentFromHeaders(headers);
  let rest = urlPath;
  const agentMatch = /^\/agent\/([a-z0-9-]+)(\/.*)$/i.exec(urlPath);
  if (agentMatch) {
    const candidate = agentMatch[1]!.toLowerCase();
    if (KNOWN_AGENT_IDS.has(candidate)) agentId = candidate as GatewayAgentId;
    rest = agentMatch[2]!;
  }
  const clean = rest.replace(/\/+$/, "");
  if (clean === "/v1/models" || clean === "/models") return { kind: "models", agentId };
  if (clean === "/v1/chat/completions" || clean === "/chat/completions") {
    return { kind: "inference", agentId, protocol: "openai_chat" };
  }
  if (clean === "/v1/responses" || clean === "/responses") {
    return { kind: "inference", agentId, protocol: "openai_responses" };
  }
  if (clean === "/v1/messages" || clean === "/messages") {
    return { kind: "inference", agentId, protocol: "anthropic" };
  }
  return { kind: "unknown" };
}

function inferAgentFromHeaders(headers: http.IncomingHttpHeaders): GatewayAgentId | "external" {
  const explicit = String(headers["x-agentrecall-agent"] ?? "").trim().toLowerCase();
  if (KNOWN_AGENT_IDS.has(explicit)) return explicit as GatewayAgentId;
  if (headers["x-deepseek-harness-session-id"]) return "deepseek-harness";
  const ua = String(headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("claude")) return "claude-code";
  if (ua.includes("codex")) return "codex";
  if (ua.includes("deepseek") || ua.includes("dsh")) return "deepseek-harness";
  if (ua.includes("opencode")) return "opencode";
  return "external";
}

function extractSessionId(headers: http.IncomingHttpHeaders): string | null {
  for (const name of [
    "x-deepseek-harness-session-id",
    "x-agentrecall-session",
    "x-session-affinity",
    "session-id",
    "x-conversation-id",
  ]) {
    const raw = headers[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function buildUpstreamUrl(baseUrl: string, pathSuffix: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (pathSuffix === "/messages") {
    // Anthropic endpoints expect `<base>/v1/messages` unless `/v1` is already present.
    return /\/v1$/i.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
  }
  return `${trimmed}${pathSuffix}`;
}

function buildUpstreamHeaders(route: ResolvedGatewayRoute): Record<string, string> {
  if (route.protocol === "anthropic") {
    return {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(route.apiKey ? { "x-api-key": route.apiKey } : {}),
    };
  }
  return {
    "content-type": "application/json",
    ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
  };
}

class BodyTooLargeError extends Error {}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new BodyTooLargeError("Gateway request body exceeds 32 MB."));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError("Gateway request body exceeds 32 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(total === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function redactKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
