import { ManagedSkillLibrary } from "../../core/managed-skill-library";
import { WorkspaceService } from "@agentrecall/workspace-core";
import Store from "electron-store";
import * as path from "node:path";
import { homedir } from "node:os";
import type { McpExternalClientConnections } from "../../automation/contracts";
import {
  BuiltinEvalMcpServer,
  BuiltinSessionSearchServer,
  BuiltinSkillMcpServer,
  type McpBuiltinRuntime,
} from "../../automation/engine/main/mcp-builtin-server";
import { createJudgeScriptRunner } from "../../core/evaluation/judge-script-runner";
import type { AppSettings } from "../../core/platform";
import type { PostgresDatabase } from "../../core/postgres/database";
import type { SessionStore } from "../../core/session-store";
import { getMcpSkill, listMcpSkills } from "../../mcp/skill-entry";
import { requestLocalSessionBackend } from "../session-backend-client";
import { NativeAutomationService } from "./automation-service";
import type { EvaluationArtifactReader } from "./evaluation-artifact-reader";
import { KnowledgeSearchService } from "./knowledge-search-service";
import type { SkillService } from "./skill-service";
import type { TeamWorkspaceService } from "./team-workspace-service";

export interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
  clientConnections(preferences: { codex: boolean; claude: boolean }, home?: string): McpExternalClientConnections;
  setClientEnabled(clientId: "codex" | "claude", enabled: boolean, options?: { homeDir?: string }): void;
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
  connections(): McpExternalClientConnections;
  ensureClients(): McpExternalClientConnections;
  setClientEnabled(clientId: "codex" | "claude", enabled: boolean): McpExternalClientConnections;
}

export function createMcpClientManager(deps: {
  loadMcpSetup: () => McpSetup;
  homePath: string;
}): McpClientManager {
  const preferenceStore = new Store<{ codex: boolean; claude: boolean }>({
    name: "mcp-client-preferences",
    defaults: { codex: true, claude: true },
  });

  const connections = (): McpExternalClientConnections =>
    deps.loadMcpSetup().clientConnections(preferenceStore.store, deps.homePath);

  return {
    connections,

    ensureClients(): McpExternalClientConnections {
      const setup = deps.loadMcpSetup();
      const preferences = preferenceStore.store;
      for (const client of setup.clientConnections(preferences, deps.homePath).clients) {
        if (client.detected && client.enabled) {
          setup.setClientEnabled(client.clientId, true, { homeDir: deps.homePath });
        }
      }
      return setup.clientConnections(preferences, deps.homePath);
    },

    setClientEnabled(clientId: "codex" | "claude", enabled: boolean): McpExternalClientConnections {
      deps.loadMcpSetup().setClientEnabled(clientId, enabled, { homeDir: deps.homePath });
      preferenceStore.set(clientId, enabled);
      return connections();
    },
  };
}

export function createConfiguredAutomationService(deps: {
  mainDir: string;
  database: PostgresDatabase;
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

  return new NativeAutomationService({
    database: deps.database,
    userDataPath: deps.userDataPath,
    homePath: deps.homePath,
    appDataPath: deps.appDataPath,
    mcpClients: {
      snapshot: () => deps.mcpClients.connections(),
      setEnabled: (request) => deps.mcpClients.setClientEnabled(request.clientId, request.enabled),
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
