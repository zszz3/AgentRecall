import { net } from "electron";
import {
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type ToolExecutionResult,
} from "../../core/ai-assistant";
import type { AppSettings } from "../../core/platform";
import { supportsAiSummarySource } from "../../core/session-sources";
import type { SessionStore } from "../../core/session-store";
import { summarizeSession, type SummaryEndpoint, type SummaryFetch } from "../../core/session-summarizer";
import {
  buildCodexExecEndpoint as buildCodexExecEndpointShared,
  resolveSummaryEndpointFromSettings as resolveSummaryEndpointFromSettingsShared,
} from "../../core/summary-endpoint";
import type { ProjectQueryOptions, ProjectSummary, SearchOptions, SessionSearchResult } from "../../core/types";
import type { ModelGatewayService } from "./model-gateway-service";
import type { ProviderService } from "./provider-service";
import type { RemoteSessionAccess } from "./remote-session-access";

const SUMMARY_PROVIDER_ERROR =
  "AI summary has no usable provider. Select Codex, Claude Code, or configure a direct summary API provider in Settings.";
const SUMMARY_HEAD_MESSAGES = 24;
const SUMMARY_TAIL_MESSAGES = 16;
// Sessions at or below this many messages are summarized in full.
const SUMMARY_FULL_THRESHOLD = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;

const electronSummaryFetch: SummaryFetch = (input, init) => net.fetch(input, init);

export interface SummaryBatchProgress {
  processed: number;
  failed: number;
  total: number;
}

export interface SessionAiService {
  buildCodexExecEndpoint(settings: AppSettings): SummaryEndpoint;
  resolveSummaryEndpoint(): Promise<SummaryEndpoint | null>;
  summarizeSession(sessionKey: string): Promise<SessionSearchResult | null>;
  summarizeMissingSessions(onProgress: (progress: SummaryBatchProgress) => void): Promise<SummaryBatchProgress>;
  maybeAutoBackfillSummaries(): Promise<void>;
  runAssistantChat(messages: AiChatMessage[]): Promise<{ reply: string; sessions: SessionSearchResult[] }>;
}

export function createSessionAiService(deps: {
  getStore: () => SessionStore;
  getSettings: () => AppSettings;
  getGatewayService: () => ModelGatewayService | null;
  providerService: ProviderService;
  remoteSessionAccess: RemoteSessionAccess;
  visibleSearchOptions: (options?: SearchOptions) => SearchOptions;
  visibleProjectOptions: () => { excludeSubagents: boolean };
  listVisibleProjects: (options?: ProjectQueryOptions) => Promise<ProjectSummary[]>;
}): SessionAiService {
  let summaryBackfillRunning = false;

  const deleteTemporarySession = (sessionKey: string): void => {
    void deps.getStore().deleteSession(sessionKey).catch(() => undefined);
  };

  const buildCodexExecEndpoint = (settings: AppSettings): SummaryEndpoint =>
    buildCodexExecEndpointShared(settings, { onTemporarySession: deleteTemporarySession });

  const resolveSummaryEndpoint = async (): Promise<SummaryEndpoint | null> => {
    const gatewayRoute = await deps.getGatewayService()?.resolveAgentRecallRoute();
    if (gatewayRoute) {
      return {
        baseUrl: gatewayRoute.baseUrl,
        model: gatewayRoute.model,
        apiKey: gatewayRoute.apiKey,
        apiFormat: gatewayRoute.protocol,
        fetch: electronSummaryFetch,
      };
    }
    const settings = await deps.providerService.hydrateSettings();
    if (settings.summarySource === "custom") {
      const summaryApiConfig = await deps.providerService.resolveSummaryApiConfig(settings);
      const endpoint = resolveSummaryEndpointFromSettingsShared(
        { ...settings, summaryApiConfigMode: "custom", summaryApiConfig },
        {},
      );
      if (endpoint) return { ...endpoint, fetch: electronSummaryFetch };
      return buildCodexExecEndpointShared(settings, { onTemporarySession: deleteTemporarySession });
    }
    return resolveSummaryEndpointFromSettingsShared(settings, { onTemporarySession: deleteTemporarySession });
  };

  // Short sessions are summarized in full; long ones use a head + tail excerpt so the
  // original problem and the final resolution both survive, fetching only a bounded slice.
  const summarizeOneSession = async (sessionKey: string, endpoint: SummaryEndpoint): Promise<void> => {
    const store = deps.getStore();
    const session = await store.getSession(sessionKey);
    if (session && !supportsAiSummarySource(session.source)) {
      throw new Error("AI summaries are disabled for CodeWiz sessions.");
    }
    const count = await store.getMessageCount(sessionKey);
    const excerpt = count <= SUMMARY_FULL_THRESHOLD
      ? {
          head: await store.getMessages(sessionKey, 0, SUMMARY_FULL_THRESHOLD),
          tail: [],
          omittedCount: 0,
        }
      : {
          head: await store.getMessages(sessionKey, 0, SUMMARY_HEAD_MESSAGES),
          tail: await store.getMessages(sessionKey, count - SUMMARY_TAIL_MESSAGES, SUMMARY_TAIL_MESSAGES),
          omittedCount: count - SUMMARY_HEAD_MESSAGES - SUMMARY_TAIL_MESSAGES,
        };
    const result = await summarizeSession(excerpt, endpoint);
    await store.setAiSummary(sessionKey, result.summary, endpoint.model);
  };

  return {
    buildCodexExecEndpoint,
    resolveSummaryEndpoint,

    async summarizeSession(sessionKey: string): Promise<SessionSearchResult | null> {
      const store = deps.getStore();
      await deps.remoteSessionAccess.ensureDetails(sessionKey);
      const session = await store.getSession(sessionKey);
      if (session && !supportsAiSummarySource(session.source)) {
        throw new Error("AI summaries are disabled for CodeWiz sessions.");
      }
      const endpoint = await resolveSummaryEndpoint();
      if (!endpoint) throw new Error(SUMMARY_PROVIDER_ERROR);
      await summarizeOneSession(sessionKey, endpoint);
      return store.getSession(sessionKey);
    },

    async summarizeMissingSessions(
      onProgress: (progress: SummaryBatchProgress) => void,
    ): Promise<SummaryBatchProgress> {
      const endpoint = await resolveSummaryEndpoint();
      if (!endpoint) throw new Error(SUMMARY_PROVIDER_ERROR);
      const settings = deps.getSettings();
      const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
      // Cover all missing/stale sessions in the age window in one run (bounded for
      // safety). Failed ones stay missing and are retried on the next run.
      const candidates = await deps.getStore().listSessionsNeedingSummary(Date.now(), maxAgeMs, 500);
      const total = candidates.length;
      let processed = 0;
      let failed = 0;
      let next = 0;
      const emit = (): void => onProgress({ processed, failed, total });
      emit();
      // A few in parallel so a large backlog finishes in reasonable wall time; each
      // request is individually time-bounded, so one slow provider can't stall it.
      const worker = async (): Promise<void> => {
        while (next < candidates.length) {
          const candidate = candidates[next++];
          try {
            await summarizeOneSession(candidate.sessionKey, endpoint);
            processed += 1;
          } catch {
            failed += 1;
          }
          emit();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
      return { processed, failed, total };
    },

    async maybeAutoBackfillSummaries(): Promise<void> {
      if (summaryBackfillRunning) return;
      const settings = deps.getSettings();
      if (!settings.summaryAutoBackfill) return;
      // Claim the flag before any await, so overlapping index completions cannot
      // both pass the guard and start duplicate backfill runs.
      summaryBackfillRunning = true;
      try {
        const endpoint = await resolveSummaryEndpoint();
        if (!endpoint) return;
        const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
        const candidates = await deps.getStore().listSessionsNeedingSummary(Date.now(), maxAgeMs, 25);
        for (const candidate of candidates) {
          try {
            await summarizeOneSession(candidate.sessionKey, endpoint);
          } catch {
            // Skip sessions the provider cannot summarize; keep going.
          }
        }
      } finally {
        summaryBackfillRunning = false;
      }
    },

    async runAssistantChat(
      messages: AiChatMessage[],
    ): Promise<{ reply: string; sessions: SessionSearchResult[] }> {
      const store = deps.getStore();
      // The assistant shares the summary provider routing. When the user picked a
      // direct API provider but left it incomplete, fall back to the local Codex
      // CLI so the assistant still works out of the box.
      const endpoint = (await resolveSummaryEndpoint())
        ?? buildCodexExecEndpoint(await deps.providerService.hydrateSettings());

      // Local CLI providers (codex exec / claude) can't do HTTP function calling.
      // Fall back to: keyword-search the store with the user's words, then let the
      // CLI write a grounded answer over the hits.
      if (isLocalCliEndpoint(endpoint)) {
        const search = async (query: string): Promise<FallbackSessionHit[]> => {
          const sessions = await store.searchSessions(deps.visibleSearchOptions({ query, limit: 12 }));
          return sessions.map((session) => ({
            sessionKey: session.sessionKey,
            title: session.displayTitle,
            source: session.source,
            project: session.projectPath,
            summary: session.aiSummary ?? session.firstQuestion ?? null,
          }));
        };
        const { reply, sessionKeys } = await runAiAssistantFallback(endpoint, messages, search);
        const sessions = (await Promise.all(sessionKeys.map((key) => store.getSession(key))))
          .filter((session): session is SessionSearchResult => session !== null);
        return { reply, sessions };
      }

      // The model's tool calls run against the local SessionStore — the same data
      // the MCP server exposes. We collect surfaced sessionKeys so the renderer can
      // hydrate full results into clickable cards.
      const executeTool = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
        switch (name) {
          case "search_sessions": {
            const query = typeof args.query === "string" ? args.query : "";
            const source = typeof args.source === "string" && args.source ? args.source : undefined;
            const projectPath = typeof args.project === "string" && args.project ? args.project : undefined;
            const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
            const sessions = await store.searchSessions(deps.visibleSearchOptions({
              query,
              source: source as SearchOptions["source"],
              projectPath,
              limit,
            }));
            return {
              result: sessions.map((session) => ({
                sessionKey: session.sessionKey,
                title: session.displayTitle,
                source: session.source,
                project: session.projectPath,
                timestamp: session.timestamp,
                summary: session.aiSummary ?? session.firstQuestion ?? null,
              })),
              sessionKeys: sessions.map((session) => session.sessionKey),
            };
          }
          case "list_projects": {
            const projects = await deps.listVisibleProjects(deps.visibleProjectOptions());
            return {
              result: projects.map((project) => ({ project: project.path, sessions: project.sessionCount })),
              sessionKeys: [],
            };
          }
          case "list_tags": {
            return { result: await store.listTags(), sessionKeys: [] };
          }
          case "get_session": {
            const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
            if (!sessionKey) return { result: { error: "sessionKey is required." }, sessionKeys: [] };
            await deps.remoteSessionAccess.ensureDetails(sessionKey);
            const session = await store.getSession(sessionKey);
            if (!session) return { result: { error: "Session not found." }, sessionKeys: [] };
            const maxMessages = typeof args.maxMessages === "number"
              ? Math.max(1, Math.min(200, Math.floor(args.maxMessages)))
              : 40;
            const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
            const messageList = await store.getMessages(sessionKey, offset, maxMessages);
            return {
              result: {
                sessionKey: session.sessionKey,
                title: session.displayTitle,
                source: session.source,
                project: session.projectPath,
                timestamp: session.timestamp,
                summary: session.aiSummary,
                totalMessages: session.messageCount,
                messages: messageList.map((message) => ({ role: message.role, content: message.content })),
              },
              sessionKeys: [session.sessionKey],
            };
          }
          default:
            return { result: { error: `Unknown tool: ${name}` }, sessionKeys: [] };
        }
      };

      const { reply, sessionKeys } = await runAiAssistantTurn(endpoint, messages, executeTool);
      const sessions = (await Promise.all(sessionKeys.map((key) => store.getSession(key))))
        .filter((session): session is SessionSearchResult => session !== null);
      return { reply, sessions };
    },
  };
}
