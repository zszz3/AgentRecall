import { ManagedSkillLibrary } from "../../core/managed-skill-library";
import { WorkspaceService } from "@agentrecall/workspace-core";
import Store from "electron-store";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { homedir } from "node:os";
import type {
  McpClientTransportPreference,
  McpExternalClientConnections,
  McpExternalClientId,
  McpExternalClientUpdate,
} from "../../automation/contracts";
import {
  BuiltinEvalMcpServer,
  BuiltinSessionSearchServer,
  BuiltinSkillMcpServer,
  type McpBuiltinRuntime,
} from "../../automation/engine/main/mcp-builtin-server";
import { createJudgeScriptRunner } from "../../core/evaluation/judge-script-runner";
import type { AppSettings } from "../../core/platform";
import type { SessionStore } from "../../core/session-store";
import { getMcpSkill, listMcpSkills } from "../../mcp/skill-entry";
import { requestLocalSessionBackend } from "../session-backend-client";
import { NativeAutomationService } from "./automation-service";
import type { EvaluationArtifactReader } from "./evaluation-artifact-reader";
import { KnowledgeSearchService } from "./knowledge-search-service";
import {
  McpCredentialService,
  type McpCredentialBackingStore,
  type McpCredentialEncryption,
} from "./mcp-credential-service";
import { DEFAULT_MCP_HUB_PORT } from "./mcp-http-hub";
import { McpOAuthService } from "./mcp-oauth-service";
import type { SkillService } from "./skill-service";
import type { AppDatabase } from "./sqlite-storage";
import type { TeamWorkspaceService } from "./team-workspace-service";

export interface McpSetupHubOptions {
  url: string;
  token: string;
}

export interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
  clientConnections(
    preferences: Partial<Record<McpExternalClientId, boolean>>,
    home?: string,
    options?: {
      transports?: Partial<Record<McpExternalClientId, McpClientTransportPreference>>;
      allowedServerIds?: Partial<Record<McpExternalClientId, string[]>>;
      hub?: McpSetupHubOptions;
    },
  ): McpExternalClientConnections;
  setClientEnabled(
    clientId: McpExternalClientId,
    enabled: boolean,
    options?: {
      homeDir?: string;
      transport?: McpClientTransportPreference;
      hub?: McpSetupHubOptions;
    },
  ): void;
  serverDefinition(): {
    id: string;
    name: string;
    command: string;
    args: string[];
    transport: string;
    env: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  };
}

export interface McpClientManager {
  hubConfig(): { port: number; url: string; token: string };
  connections(): McpExternalClientConnections;
  ensureClients(): McpExternalClientConnections;
  setClientConnection(request: McpExternalClientUpdate): McpExternalClientConnections;
  allowedServerIds(clientId: McpExternalClientId): readonly string[] | undefined;
}

interface McpClientPreferenceStore {
  codex?: boolean;
  claude?: boolean;
  cursor?: boolean;
  gemini?: boolean;
  opencode?: boolean;
  qwen?: boolean;
  zcode?: boolean;
  transports?: Partial<Record<McpExternalClientId, McpClientTransportPreference>>;
  allowedServerIds?: Partial<Record<McpExternalClientId, string[]>>;
  hubToken?: string;
  hubPort?: number;
}

export function createMcpClientManager(deps: {
  loadMcpSetup: () => McpSetup;
  homePath: string;
}): McpClientManager {
  const preferenceStore = new Store<McpClientPreferenceStore>({
    name: "mcp-client-preferences",
    defaults: { codex: true, claude: true },
  });

  const hubConfig = (): { port: number; url: string; token: string } => {
    let token = preferenceStore.get("hubToken");
    if (typeof token !== "string" || token.length < 32) {
      token = randomBytes(32).toString("hex");
      preferenceStore.set("hubToken", token);
    }
    const storedPort = preferenceStore.get("hubPort");
    const port = typeof storedPort === "number" && Number.isInteger(storedPort) && storedPort >= 1024 && storedPort <= 65535
      ? storedPort
      : DEFAULT_MCP_HUB_PORT;
    return { port, url: `http://127.0.0.1:${port}/mcp`, token };
  };

  const connections = (): McpExternalClientConnections => {
    const hub = hubConfig();
    return deps.loadMcpSetup().clientConnections(preferenceStore.store, deps.homePath, {
      transports: preferenceStore.get("transports") ?? {},
      allowedServerIds: preferenceStore.get("allowedServerIds") ?? {},
      hub: { url: hub.url, token: hub.token },
    });
  };

  return {
    hubConfig,
    connections,

    ensureClients(): McpExternalClientConnections {
      const setup = deps.loadMcpSetup();
      const hub = hubConfig();
      const current = connections();
      for (const client of current.clients) {
        if (client.detected && client.enabled) {
          setup.setClientEnabled(client.clientId, true, {
            homeDir: deps.homePath,
            transport: client.transport,
            hub: { url: hub.url, token: hub.token },
          });
        }
      }
      return connections();
    },

    setClientConnection(request: McpExternalClientUpdate): McpExternalClientConnections {
      const hub = hubConfig();
      const transports = { ...(preferenceStore.get("transports") ?? {}) };
      if (request.transport) {
        transports[request.clientId] = request.transport;
        preferenceStore.set("transports", transports);
      }
      const nextTransport = request.transport
        ?? transports[request.clientId]
        ?? (request.clientId === "codex" || request.clientId === "claude" ? "stdio" : "http");

      if (request.allowedServerIds !== undefined) {
        const allowed = { ...(preferenceStore.get("allowedServerIds") ?? {}) };
        if (request.allowedServerIds === null) {
          delete allowed[request.clientId];
        } else {
          allowed[request.clientId] = [...new Set(request.allowedServerIds)];
        }
        preferenceStore.set("allowedServerIds", allowed);
      }

      deps.loadMcpSetup().setClientEnabled(request.clientId, request.enabled, {
        homeDir: deps.homePath,
        transport: nextTransport,
        hub: { url: hub.url, token: hub.token },
      });
      preferenceStore.set(request.clientId, request.enabled);
      return connections();
    },

    allowedServerIds(clientId: McpExternalClientId): readonly string[] | undefined {
      const allowed = preferenceStore.get("allowedServerIds")?.[clientId];
      return Array.isArray(allowed) ? allowed : undefined;
    },
  };
}

export function createConfiguredAutomationService(deps: {
  mainDir: string;
  database: AppDatabase;
  connectionUrl: () => string | null;
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  skillLibraryRoot: string;
  store: SessionStore;
  skillService: SkillService;
  evaluationArtifacts: EvaluationArtifactReader;
  getTeamWorkspaceService: () => TeamWorkspaceService | null;
  getSettings: () => AppSettings;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  loadMcpSetup: () => McpSetup;
  mcpClients: McpClientManager;
  credentialEncryption?: McpCredentialEncryption;
  openExternal?: (url: string) => Promise<void> | void;
  chooseEvaluationDatasetDirectory: (mode: "read" | "write") => Promise<string | null>;
}): NativeAutomationService {
  // Runtime state (discovered tools, per-tool toggles, last test result) for built-in
  // MCP servers stays apart from AppSettings so internal state never leaks into user settings.
  const mcpRuntimeStore = new Store<McpBuiltinRuntime>({
    name: "mcp-runtime",
    defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
  });
  const skillMcpRuntimeStore = new Store<McpBuiltinRuntime>({
    name: "skill-mcp-runtime",
    defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
  });
  const evalMcpRuntimeStore = new Store<McpBuiltinRuntime>({
    name: "eval-mcp-runtime",
    defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
  });

  const knowledge = new KnowledgeSearchService({
    workspace: new WorkspaceService(process.env.AGENTRECALL_HOME ?? path.join(homedir(), ".agentrecall-cli")),
    team: () => {
      const team = deps.getTeamWorkspaceService();
      if (!team) throw new Error("团队服务尚未就绪，请稍后重试。");
      return team;
    },
    localSkills: () => new ManagedSkillLibrary({
      libraryRoot: deps.skillLibraryRoot,
      homeDir: deps.homePath,
      codexHome: process.env.CODEX_HOME,
    }).list().skills.map((skill) => ({
      id: skill.managedId,
      type: "skill" as const,
      title: skill.name,
      description: skill.description,
      content: skill.markdown,
    })),
    localSearch: (value) => requestLocalSessionBackend("search", value, { userDataPath: deps.userDataPath, desktopPid: process.pid }),
    localRead: (value) => requestLocalSessionBackend("get", value, { userDataPath: deps.userDataPath, desktopPid: process.pid }),
  });

  const mcpCredentialStore = new Store<{
    secrets: Record<string, { env?: Record<string, string>; header?: Record<string, string> }>;
    oauth: Record<string, string>;
  }>({
    name: "mcp-credentials",
    defaults: { secrets: {}, oauth: {} },
  });
  const mcpCredentials = deps.credentialEncryption
    ? new McpCredentialService(mcpCredentialStore as unknown as McpCredentialBackingStore, deps.credentialEncryption)
    : undefined;
  const mcpOAuth = mcpCredentials && deps.openExternal
    ? new McpOAuthService({ credentials: mcpCredentials, openExternal: deps.openExternal })
    : undefined;

  const hubConfig = deps.mcpClients.hubConfig();
  return new NativeAutomationService({
    database: deps.database,
    userDataPath: deps.userDataPath,
    homePath: deps.homePath,
    appDataPath: deps.appDataPath,
    mcpHub: {
      enabled: true,
      port: hubConfig.port,
      token: hubConfig.token,
    },
    ...(mcpCredentials ? { mcpCredentials } : {}),
    ...(mcpOAuth ? { mcpOAuth } : {}),
    mcpClients: {
      snapshot: () => deps.mcpClients.connections(),
      setEnabled: (request) => deps.mcpClients.setClientConnection(request),
      allowedServerIds: (clientId) => deps.mcpClients.allowedServerIds(clientId),
    },
    gatewayDirect: {
      listSkills: async () => listMcpSkills({
        libraryRoot: deps.skillLibraryRoot,
        homeDir: deps.homePath,
        codexHome: process.env.CODEX_HOME,
      }),
      getSkill: async (value) => {
        const record = value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
        const managedId = typeof record.managedId === "string" ? record.managedId.trim() : "";
        if (!managedId) throw new Error("managedId is required.");
        const skill = getMcpSkill(managedId, {
          libraryRoot: deps.skillLibraryRoot,
          homeDir: deps.homePath,
          codexHome: process.env.CODEX_HOME,
        });
        if (!skill) throw new Error(`Skill was not found: ${managedId}`);
        return skill;
      },
      searchSessions: (value) => knowledge.searchSessions(value),
      getSession: (value) => knowledge.getSession(value),
      searchResources: (value) => knowledge.searchResources(value),
      getResource: (value) => knowledge.getResource(value),
    },
    readEvaluationSkill: (skillName) => deps.skillService.readSkillInstructions(skillName),
    resolveEvaluationSession: async (reference) => {
      if (!reference.invocationId) return null;
      const resolution = await deps.store.resolveRuntimeInvocationSession({
        invocationId: reference.invocationId,
        surface: "evaluation",
      });
      return resolution.status === "found"
        ? {
            sessionKey: resolution.session.sessionKey,
            source: resolution.session.source,
            rawId: resolution.session.rawId,
          }
        : null;
    },
    readEvaluationTrajectory: (sessionKey) => deps.evaluationArtifacts.readTrajectory(sessionKey),
    readEvaluationSessionArtifact: (sessionKey) => deps.evaluationArtifacts.readSessionArtifact(sessionKey),
    readEvaluationArtifactFiles: (sessionKey) => deps.evaluationArtifacts.readArtifactFiles(sessionKey),
    readEvaluationStageTrace: (sessionKey) => deps.evaluationArtifacts.readStageTrace(sessionKey),
    readEvaluationStageTexts: (sessionKey) => deps.evaluationArtifacts.readStageTexts(sessionKey),
    readEvaluationFolderArtifact: (directory) => deps.evaluationArtifacts.readFolderArtifact(directory),
    chooseEvaluationDatasetDirectory: (mode) => deps.chooseEvaluationDatasetDirectory(mode),
    // Inline JS judges always run, sandboxed. A command judge is a real process,
    // so it is read from the setting on every call rather than captured here.
    runEvaluationJudgeScript: createJudgeScriptRunner({
      commandsEnabled: () => deps.getSettings().evalScriptCommandsEnabled,
      defaultCwd: deps.userDataPath,
    }),
    builtinSessionSearch: new BuiltinSessionSearchServer({
      isEnabled: () => deps.getSettings().sessionSearchMcpEnabled,
      setEnabled: async (next) => {
        deps.setSetting("sessionSearchMcpEnabled", next);
        return next;
      },
      launchConfig: () => {
        const definition = deps.loadMcpSetup().serverDefinition();
        return {
          id: definition.id,
          name: "AgentRecall Session Search",
          description: "检索已索引的 Agent 会话、查看上下文，并准备可恢复的迁移。",
          command: definition.command,
          args: definition.args,
        };
      },
      testEnv: (): Record<string, string> => {
        const url = deps.connectionUrl();
        return url ? { AGENT_RECALL_DATABASE_URL: url } : {};
      },
      readRuntime: () => mcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        mcpRuntimeStore.store = runtime;
      },
    }),
    builtinSkills: new BuiltinSkillMcpServer({
      isEnabled: () => deps.getSettings().skillMcpEnabled,
      setEnabled: async (next) => {
        deps.setSetting("skillMcpEnabled", next);
        return next;
      },
      launchConfig: () => ({
        id: "agent-recall-skills",
        name: "AgentRecall Skills",
        description: "列出 AgentRecall 已管理的 Skill，并按需读取完整说明。",
        command: "node",
        args: [path.join(deps.mainDir, "..", "..", "bin", "agent-recall-skill-mcp.mjs")],
      }),
      testEnv: () => ({ AGENT_RECALL_SKILL_LIBRARY: deps.skillLibraryRoot }),
      readRuntime: () => skillMcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        skillMcpRuntimeStore.store = runtime;
      },
    }),
    builtinEval: new BuiltinEvalMcpServer({
      isEnabled: () => deps.getSettings().evalMcpEnabled,
      setEnabled: async (next) => {
        deps.setSetting("evalMcpEnabled", next);
        return next;
      },
      launchConfig: () => ({
        id: "agent-recall-eval",
        name: "AgentRecall Eval",
        description: "读写评测数据集，并查看评分器、执行图与运行结果。",
        command: "node",
        args: [path.join(deps.mainDir, "..", "..", "bin", "agent-recall-eval-mcp.mjs")],
      }),
      testEnv: (): Record<string, string> => {
        const url = deps.connectionUrl();
        return url ? { AGENT_RECALL_DATABASE_URL: url } : {};
      },
      readRuntime: () => evalMcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        evalMcpRuntimeStore.store = runtime;
      },
    }),
  });
}
