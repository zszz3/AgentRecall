import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { indexMigratedSessionFile, type IndexStatus } from "../../core/indexer";
import { assertMigrationTargetEnabled, migrationTargetDescriptor } from "../../core/migration-targets";
import {
  getMigrationResumeProcessSpec,
  getRemoteMigrationCliVersionCommand,
  getResumeCommand,
  getSafeMigrationResumeCommand,
  inspectMigrationCli,
  openMigrationResumeInTerminal,
  openResumeInTerminal,
  remoteMigrationSettings,
  type AppSettings,
} from "../../core/platform";
import { REMOTE_PROCESS_EXEC_OPTIONS, runRemoteCommand, runRemoteCommandWithInput } from "../../core/remote-process";
import { restoreRemotePortableSession, type RemoteSessionRestoreDependencies } from "../../core/remote-session-restore";
import { buildRemoteInteractiveSshArgs, syncRemoteEnvironment } from "../../core/remote-sync";
import { remoteSessionKey } from "../../core/session-environment";
import { collectMigrationDescendants, migrateSession, portableSessionFrom, sshMigrationTarget } from "../../core/session-migration";
import { applyMigrationLengthPolicy, createMigrationCompressor } from "../../core/session-migration-compression";
import { targetFilePathForRemoteEnvironment, writeMigratedSession } from "../../core/session-migration-writers";
import type { SessionStore } from "../../core/session-store";
import type { SummaryEndpoint } from "../../core/session-summarizer";
import type {
  MigrationAgent,
  MigrationTarget,
  PortableSession,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionMigrationRequest,
  SessionMigrationResult,
  SessionSearchResult,
  SessionSource,
} from "../../core/types";
import { loadLocalSessionMigrationSource, runLocalSessionMigration } from "../local-session-migration";
import type { RemoteSessionAccess } from "./remote-session-access";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function buildPythonBase64Command(script: string): string {
  const compressed = deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  return `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
}

const REMOTE_WRITE_FILE_SCRIPT = [
  "import base64, json, os, sys, uuid",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "target = Path(payload['path'])",
  "content = base64.b64decode(payload['contentBase64'])",
  "target.parent.mkdir(parents=True, exist_ok=True)",
  "tmp = target.with_name(target.name + '.tmp-' + uuid.uuid4().hex)",
  "try:",
  "  tmp.write_bytes(content)",
  "  os.chmod(tmp, 0o600)",
  "  os.link(tmp, target)",
  "  tmp.unlink()",
  "finally:",
  "  if tmp.exists(): tmp.unlink()",
  "print(str(target))",
].join("\n");

const REMOTE_UPDATE_CODEX_INDEX_SCRIPT = [
  "import json, os, sys, uuid",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "index = Path(payload['path'])",
  "rows = []",
  "if index.exists():",
  "    for line in index.read_text(encoding='utf-8').splitlines():",
  "        if line.strip(): rows.append(json.loads(line))",
  "rows = [row for row in rows if not isinstance(row, dict) or row.get('id') != payload['id']]",
  "rows.append({'id': payload['id'], 'thread_name': payload['threadName'], 'updated_at': payload['updatedAt']})",
  "index.parent.mkdir(parents=True, exist_ok=True)",
  "tmp = index.with_name(index.name + '.tmp-' + uuid.uuid4().hex)",
  "tmp.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\\n' for row in rows), encoding='utf-8')",
  "os.chmod(tmp, 0o600)",
  "os.replace(tmp, index)",
  "print(str(index))",
].join("\n");

const REMOTE_UPDATE_CODEX_STATE_SCRIPT = [
  "import json, sqlite3, sys",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "home = Path(payload['home'])",
  "candidates = sorted((home / '.codex').glob('state_*.sqlite'), key=lambda item: item.stat().st_mtime, reverse=True)",
  "if not candidates: print('Codex state database not found'); sys.exit(0)",
  "db = sqlite3.connect(str(candidates[0]), timeout=5)",
  "db.row_factory = sqlite3.Row",
  "columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}",
  "required = {'id', 'rollout_path', 'created_at', 'updated_at', 'source', 'model_provider', 'cwd', 'title', 'sandbox_policy', 'approval_mode'}",
  "if not required.issubset(columns): db.close(); print('Codex state database schema not supported'); sys.exit(0)",
  "existing = db.execute('SELECT * FROM threads WHERE id = ?', (payload['id'],)).fetchone()",
  "order_column = 'updated_at_ms' if 'updated_at_ms' in columns else 'updated_at'",
  "template = existing or db.execute(f'SELECT * FROM threads ORDER BY {order_column} DESC LIMIT 1').fetchone()",
  "def value(name, fallback=None): return existing[name] if existing and name in existing.keys() and existing[name] is not None else (template[name] if template and name in template.keys() and template[name] is not None else fallback)",
  "created_ms = int(payload['createdAtMs'])",
  "updated_ms = int(payload['updatedAtMs'])",
  "values = {",
  "  'id': payload['id'], 'rollout_path': payload['rolloutPath'],",
  "  'created_at': value('created_at', created_ms // 1000), 'updated_at': updated_ms // 1000,",
  "  'source': 'vscode', 'model_provider': value('model_provider', payload['modelProvider']),",
  "  'cwd': payload['cwd'], 'title': payload['title'],",
  "  'sandbox_policy': value('sandbox_policy', '{}'), 'approval_mode': value('approval_mode', 'on-request'),",
  "  'tokens_used': value('tokens_used', 0), 'has_user_event': 1, 'archived': value('archived', 0),",
  "  'cli_version': 'migration', 'first_user_message': payload['firstUserMessage'],",
  "  'memory_mode': value('memory_mode', 'enabled'), 'model': value('model'), 'reasoning_effort': value('reasoning_effort'),",
  "  'agent_path': value('agent_path'), 'created_at_ms': value('created_at_ms', created_ms), 'updated_at_ms': updated_ms,",
  "  'thread_source': 'user', 'preview': payload['title'], 'recency_at': updated_ms // 1000, 'recency_at_ms': updated_ms,",
  "  'history_mode': 'legacy'",
  "}",
  "values = {key: value for key, value in values.items() if key in columns}",
  "if existing:",
  "    assignments = ', '.join(f'{key} = ?' for key in values if key != 'id')",
  "    params = [values[key] for key in values if key != 'id'] + [payload['id']]",
  "    db.execute(f'UPDATE threads SET {assignments} WHERE id = ?', params)",
  "else:",
  "    names = ', '.join(values)",
  "    placeholders = ', '.join('?' for _ in values)",
  "    db.execute(f'INSERT INTO threads ({names}) VALUES ({placeholders})', list(values.values()))",
  "db.commit()",
  "db.close()",
  "print(str(candidates[0]))",
].join("\n");

function migrationLaunchSession(
  environment: SessionEnvironment,
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): SessionSearchResult {
  const source = migrationTargetDescriptor(target).source;
  return {
    sessionKey: remoteSessionKey(environment, source, sessionId),
    rawId: sessionId,
    source,
    projectPath,
    filePath: "",
    originalTitle: sessionId,
    firstQuestion: "",
    displayTitle: sessionId,
    timestamp: Date.now(),
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    gitBranch: null,
    isSubagent: false,
    parentSessionId: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    environmentId: environment.id,
    environmentKind: environment.kind,
    environmentLabel: environment.label,
    customTitle: null,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 0,
    aiSummary: null,
    aiSummaryStale: false,
  };
}

export interface SessionMigrationCoordinator {
  createLocalRemoteRestoreDependencies(
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies>;
  createSourceRemoteRestoreDependencies(
    environment: SessionEnvironment,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies>;
  migrateSession(
    request: SessionMigrationRequest,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<SessionMigrationResult>;
}

export function createSessionMigrationCoordinator(deps: {
  getStore: () => SessionStore;
  getSettings: () => AppSettings;
  hydrateSettings: () => Promise<AppSettings>;
  resolveSummaryEndpoint: () => Promise<SummaryEndpoint | null>;
  buildCodexExecEndpoint: (settings: AppSettings) => SummaryEndpoint;
  remoteSessionAccess: RemoteSessionAccess;
  runSshSessionCommand: (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;
  runSshWithInput: (environment: SessionEnvironment, remoteCommand: string, input: string) => Promise<string>;
  enabledRemoteOptionalSources: (settings: AppSettings) => SessionSource[];
  tempDir: () => string;
  onIndexStatusUpdated: (status: IndexStatus) => void;
  onEnvironmentsUpdated: (environments: SessionEnvironment[]) => void;
}): SessionMigrationCoordinator {
  const runRemoteWithInput = (
    environment: SessionEnvironment,
    remoteCommand: string,
    input: string,
  ): Promise<string> => (
    environment.kind === "wsl"
      ? runRemoteCommandWithInput(environment, remoteCommand, input, REMOTE_PROCESS_EXEC_OPTIONS)
      : deps.runSshWithInput(environment, remoteCommand, input)
  );

  const runRemotePython = (
    environment: SessionEnvironment,
    script: string,
    payload: unknown,
  ): Promise<string> => {
    const remoteCommand = buildPythonBase64Command(script);
    return runRemoteWithInput(environment, remoteCommand, `${JSON.stringify(payload)}\n`);
  };

  const remoteHomeDir = async (environment: SessionEnvironment): Promise<string> => {
    const output = await runRemotePython(environment, "from pathlib import Path\nprint(Path.home())", {});
    const home = output.trim();
    if (!home) throw new Error("Could not resolve remote home directory.");
    return home;
  };

  const runRemotePathCheck = async (
    environment: SessionEnvironment,
    targetPath: string,
    check: "exists" | "is_dir",
  ): Promise<string> => {
    const output = await runRemotePython(
      environment,
      [
        "import json, sys",
        "from pathlib import Path",
        "payload = json.load(sys.stdin)",
        "path = Path(payload['path'])",
        "check = payload['check']",
        "print('true' if (path.exists() if check == 'exists' else path.is_dir()) else 'false')",
      ].join("\n"),
      { path: targetPath, check },
    );
    return output.trim();
  };

  const remotePathExists = async (environment: SessionEnvironment, targetPath: string): Promise<boolean> =>
    (await runRemotePathCheck(environment, targetPath, "exists")) === "true";

  const remotePathIsDirectory = async (environment: SessionEnvironment, targetPath: string): Promise<boolean> =>
    (await runRemotePathCheck(environment, targetPath, "is_dir")) === "true";

  const updateRemoteCodexSessionIndex = async (
    environment: SessionEnvironment,
    remoteHome: string,
    session: PortableSession,
    sessionId: string,
    now: Date,
  ): Promise<void> => {
    const indexPath = `${remoteHome.replace(/[\\/]+$/, "")}/.codex/session_index.jsonl`;
    const title = session.title || session.messages.find((message) => message.role === "user")?.content || sessionId;
    await runRemotePython(environment, REMOTE_UPDATE_CODEX_INDEX_SCRIPT, {
      path: indexPath,
      id: sessionId,
      threadName: title,
      updatedAt: now.toISOString(),
    });
  };

  const updateRemoteCodexAppState = async (
    environment: SessionEnvironment,
    remoteHome: string,
    rolloutPath: string,
    session: PortableSession,
    sessionId: string,
    now: Date,
  ): Promise<void> => {
    try {
      const title = session.title || session.messages.find((message) => message.role === "user")?.content || sessionId;
      const firstUserMessage = session.messages.find((message) => message.role === "user")?.content || "";
      await runRemotePython(environment, REMOTE_UPDATE_CODEX_STATE_SCRIPT, {
        home: remoteHome,
        id: sessionId,
        rolloutPath,
        cwd: session.projectPath || remoteHome,
        title,
        firstUserMessage,
        createdAtMs: new Date(session.startedAt).getTime(),
        updatedAtMs: now.getTime(),
        modelProvider: "openai",
      });
    } catch {
      // The Codex app-server may hold its state database open. The rollout file
      // and session index remain authoritative when this display update fails.
    }
  };

  const writeMigratedSessionToSshEnvironment = async (
    environment: SessionEnvironment,
    target: MigrationAgent,
    session: PortableSession,
    targetSessionId?: string,
  ): Promise<{ sessionId: string; filePath: string }> => {
    const now = new Date();
    const tempHome = await fs.mkdtemp(path.join(deps.tempDir(), "agent-session-remote-restore-"));
    try {
      const remoteHome = await remoteHomeDir(environment);
      const written = await writeMigratedSession({
        target,
        session,
        sessionId: targetSessionId,
        homeDir: tempHome,
        now,
        codexRuntimeCwd: session.projectPath || remoteHome,
      });
      const remotePath = targetFilePathForRemoteEnvironment(
        target,
        session.projectPath,
        written.sessionId,
        remoteHome,
        now,
        session.isSubagent ? session.parentSessionId : null,
      );
      const content = await fs.readFile(written.filePath);
      await runRemotePython(environment, REMOTE_WRITE_FILE_SCRIPT, {
        path: remotePath,
        contentBase64: content.toString("base64"),
      });
      if (target === "codex") {
        // Keep the rollout file when the index request fails. The request may
        // have committed remotely before its response was lost; deleting the
        // file here would leave an index entry that points at nothing. A later
        // sync can safely rebuild the index from this durable file.
        await updateRemoteCodexSessionIndex(environment, remoteHome, session, written.sessionId, now);
        await updateRemoteCodexAppState(environment, remoteHome, remotePath, session, written.sessionId, now);
      }
      return { sessionId: written.sessionId, filePath: remotePath };
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  };

  const inspectWslMigrationCli = async (environment: SessionEnvironment, target: MigrationAgent): Promise<void> => {
    await inspectMigrationCli(
      target,
      remoteMigrationSettings(deps.getSettings()),
      async (command, args) => runRemoteCommand(environment, [command, ...args].join(" ")),
      { platform: "linux" },
    );
  };

  const inspectSshMigrationCli = async (environment: SessionEnvironment, target: MigrationAgent): Promise<void> => {
    await inspectMigrationCli(
      target,
      remoteMigrationSettings(deps.getSettings()),
      (command, args) => deps.runSshSessionCommand(
        environment,
        getRemoteMigrationCliVersionCommand(command, args),
      ),
      { platform: "linux" },
    );
  };

  const remoteMigrationResumeDisplayCommand = (
    environment: SessionEnvironment,
    target: MigrationAgent,
    sessionId: string,
    projectPath: string,
  ): string => {
    if (environment.kind === "wsl") {
      if (!environment.wslDistribution) {
        throw new Error("WSL distribution is not configured for this remote session.");
      }
      return getResumeCommand(
        migrationLaunchSession(environment, target, sessionId, projectPath),
        deps.getSettings(),
        { wslDistribution: environment.wslDistribution },
      );
    }
    const sshArgs = buildRemoteInteractiveSshArgs(environment, "").slice(0, -1);
    return getResumeCommand(
      migrationLaunchSession(environment, target, sessionId, projectPath),
      deps.getSettings(),
      { sshArgs },
    );
  };

  const createLocalRemoteRestoreDependencies = async (
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies> => {
    const settings = await deps.hydrateSettings();
    const endpoint = await deps.resolveSummaryEndpoint();
    const compressor = endpoint
      ? createMigrationCompressor(
          endpoint,
          undefined,
          settings.compressionConcurrency,
          settings.migrationCompleteTokenLimit,
        )
      : null;

    return {
      inspectCli: (target) => inspectMigrationCli(target, deps.getSettings()),
      prepare: (session, listener) => applyMigrationLengthPolicy(
        session,
        compressor,
        listener,
        settings.migrationCompleteTokenLimit,
      ),
      write: (target, session, targetSessionId) =>
        writeMigratedSession({ target, session, sessionId: targetSessionId }),
      record: (record) => deps.getStore().recordSessionMigration(record),
      refreshIndex: async (target, writtenFilePath, targetSessionId) => {
        const status = await indexMigratedSessionFile(deps.getStore(), target, writtenFilePath, targetSessionId);
        deps.onIndexStatusUpdated(status);
      },
      launch: (target, targetSessionId, projectPath) =>
        openMigrationResumeInTerminal(target, targetSessionId, projectPath, deps.getSettings()),
      resumeCommand: (target, sessionId, projectPath) =>
        getMigrationResumeProcessSpec(target, sessionId, projectPath, deps.getSettings()).displayCommand,
      fallbackResumeCommand: (target, sessionId, projectPath) =>
        getSafeMigrationResumeCommand(target, sessionId, projectPath, deps.getSettings()),
      onProgress,
      idFactory: () => randomUUID(),
      targetSessionIdFactory: () => randomUUID(),
      now: () => Date.now(),
      projectPathExists: pathExists,
      projectPathIsDirectory: pathIsDirectory,
    };
  };

  const createSourceRemoteRestoreDependencies = async (
    environment: SessionEnvironment,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies> => {
    const settings = await deps.hydrateSettings();
    const endpoint = await deps.resolveSummaryEndpoint();
    const compressor = endpoint
      ? createMigrationCompressor(
          endpoint,
          undefined,
          settings.compressionConcurrency,
          settings.migrationCompleteTokenLimit,
        )
      : null;

    return {
      inspectCli: (target) =>
        environment.kind === "ssh"
          ? inspectSshMigrationCli(environment, target)
          : inspectWslMigrationCli(environment, target),
      prepare: (session, listener) => applyMigrationLengthPolicy(
        session,
        compressor,
        listener,
        settings.migrationCompleteTokenLimit,
      ),
      write: (target, session, targetSessionId) =>
        writeMigratedSessionToSshEnvironment(environment, target, session, targetSessionId),
      record: (record) => deps.getStore().recordSessionMigration(record),
      refreshIndex: async () => {
        const store = deps.getStore();
        await syncRemoteEnvironment(store, environment, {
          ...(environment.kind === "ssh" ? { runSsh: deps.runSshSessionCommand } : {}),
          enabledOptionalSources: deps.enabledRemoteOptionalSources(deps.getSettings()),
        });
        deps.onEnvironmentsUpdated(await store.listEnvironments());
      },
      launch: async (target, targetSessionId, projectPath) => {
        const session = migrationLaunchSession(environment, target, targetSessionId, projectPath);
        if (environment.kind === "wsl") {
          await openResumeInTerminal(
            session,
            deps.getSettings(),
            await deps.remoteSessionAccess.requireWslResumeOptions(session),
          );
          return;
        }
        const sshArgs = buildRemoteInteractiveSshArgs(environment, "").slice(0, -1);
        await openResumeInTerminal(session, deps.getSettings(), { sshArgs });
      },
      resumeCommand: (target, targetSessionId, projectPath) =>
        remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
      fallbackResumeCommand: (target, targetSessionId, projectPath) =>
        remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
      onProgress,
      idFactory: () => randomUUID(),
      targetSessionIdFactory: () => randomUUID(),
      now: () => Date.now(),
      projectPathExists: (projectPath) => remotePathExists(environment, projectPath),
      projectPathIsDirectory: (projectPath) => remotePathIsDirectory(environment, projectPath),
    };
  };

  return {
    createLocalRemoteRestoreDependencies,
    createSourceRemoteRestoreDependencies,

    async migrateSession(
      request: SessionMigrationRequest,
      onProgress: (progress: SessionMigrationProgress) => void,
    ): Promise<SessionMigrationResult> {
      const store = deps.getStore();
      const source = await store.getSession(request.sessionKey);
      if (source?.environmentKind === "wsl" || source?.environmentKind === "ssh") {
        await deps.remoteSessionAccess.ensureDetails(request.sessionKey);
        const descendants = collectMigrationDescendants(
          source,
          await store.searchSessions({ limit: 100_000, excludeSubagents: false }),
        );
        for (const child of descendants) await deps.remoteSessionAccess.ensureDetails(child.sessionKey);
      }
      const migrationSource = await loadLocalSessionMigrationSource(store, request);
      const settings = Object.freeze(await deps.hydrateSettings());
      const targetEnvironment = request.targetEnvironmentId
        ? await store.getEnvironment(request.targetEnvironmentId)
        : null;
      if (request.targetEnvironmentId && !targetEnvironment) {
        throw new Error("Migration target environment is not configured.");
      }
      if (targetEnvironment && targetEnvironment.kind !== "local" && !targetEnvironment.enabled) {
        throw new Error(`Migration target environment ${targetEnvironment.label} is disabled.`);
      }
      const sourceEnvironmentId = migrationSource.source.environmentId;
      const crossEnvironment = targetEnvironment !== null && targetEnvironment.id !== sourceEnvironmentId;
      if (crossEnvironment) {
        assertMigrationTargetEnabled(request.target, settings);
        if (request.target === "codewiz" && targetEnvironment?.kind !== "local") {
          throw new Error("CodeWiz migration into WSL or SSH is disabled until its shared database can be updated transactionally.");
        }
        if (
          migrationSource.source.environmentKind === "ssh"
          && request.target !== sshMigrationTarget(migrationSource.source.source)
        ) {
          throw new Error("SSH sessions can only migrate between Claude Code and Codex on the same host.");
        }
        if (
          migrationSource.source.environmentKind === "wsl"
          && !["claude", "codex", "codebuddy", "cursor"].includes(request.target)
        ) {
          throw new Error(`Migration target ${request.target} is not supported in WSL.`);
        }
        const portable = portableSessionFrom(migrationSource.source, migrationSource.messages, {
          turnSourceMessageIndexes: migrationSource.turnSourceMessageIndexes,
          allowSsh: migrationSource.source.environmentKind === "ssh",
        });
        if (migrationSource.subagents.length > 0) portable.subagents = migrationSource.subagents;
        const restoreDeps = targetEnvironment!.kind === "local"
          ? await createLocalRemoteRestoreDependencies(onProgress)
          : await createSourceRemoteRestoreDependencies(targetEnvironment!, onProgress);
        return restoreRemotePortableSession({
          remoteId: request.sessionKey,
          portable,
          target: request.target as MigrationAgent,
          // A project path from another environment is not portable. Callers can
          // provide an explicit destination path; otherwise start without one.
          localProjectPath: request.targetProjectPath ?? "",
          deps: restoreDeps,
        });
      }

      if (migrationSource.source.environmentKind === "wsl" || migrationSource.source.environmentKind === "ssh") {
        assertMigrationTargetEnabled(request.target, settings);
        if (request.target === "codewiz") {
          throw new Error("CodeWiz migration is disabled for WSL and SSH until its shared database can be updated transactionally.");
        }
        if (
          migrationSource.source.environmentKind === "ssh"
          && request.target !== sshMigrationTarget(migrationSource.source.source)
        ) {
          throw new Error("SSH sessions can only migrate between Claude Code and Codex on the same host.");
        }
        if (
          migrationSource.source.environmentKind === "wsl"
          && !["claude", "codex", "codebuddy", "cursor"].includes(request.target)
        ) {
          throw new Error(`Migration target ${request.target} is not supported in WSL.`);
        }
        const environment = migrationSource.source.environmentKind === "wsl"
          ? await deps.remoteSessionAccess.requireWslEnvironment(migrationSource.source)
          : await deps.remoteSessionAccess.requireRemoteSshEnvironment(migrationSource.source);
        if (!environment) throw new Error("SSH environment is not available for this remote session.");
        const portable = portableSessionFrom(migrationSource.source, migrationSource.messages, {
          turnSourceMessageIndexes: migrationSource.turnSourceMessageIndexes,
          allowSsh: migrationSource.source.environmentKind === "ssh",
        });
        if (migrationSource.subagents.length > 0) portable.subagents = migrationSource.subagents;
        const restoreDeps = await createSourceRemoteRestoreDependencies(environment, onProgress);
        return restoreRemotePortableSession({
          remoteId: request.sessionKey,
          portable,
          target: request.target as MigrationAgent,
          localProjectPath: request.targetProjectPath ?? portable.projectPath,
          deps: restoreDeps,
        });
      }

      return runLocalSessionMigration(
        {
          ...migrationSource,
          target: request.target,
          targetProjectPath: request.targetProjectPath,
          settings,
        },
        {
          // Falling back to the local Codex exec route keeps migration compression working when
          // no summary Provider is configured, instead of silently skipping compression.
          resolveSummaryEndpoint: async () => (await deps.resolveSummaryEndpoint())
            ?? deps.buildCodexExecEndpoint(await deps.hydrateSettings()),
          createCompressor: (endpoint, concurrency, completeTokenLimit) =>
            createMigrationCompressor(endpoint, undefined, concurrency, completeTokenLimit),
          migrate: migrateSession,
          inspectCli: (migrationTarget: MigrationTarget, snapshot: AppSettings) =>
            inspectMigrationCli(migrationTarget, snapshot),
          prepare: (portable, listener, compressor, completeTokenLimit) =>
            applyMigrationLengthPolicy(portable, compressor, listener, completeTokenLimit),
          write: (migrationTarget, portable, targetSessionId) =>
            writeMigratedSession({
              target: migrationTarget,
              session: portable,
              sessionId: targetSessionId,
              // Test/sandboxed launches may redirect the migration home so writes
              // to ~/.codex, ~/.dsh, ... never hit a TCC-protected real home.
              ...(process.env.AGENT_RECALL_MIGRATION_HOME
                ? { homeDir: process.env.AGENT_RECALL_MIGRATION_HOME }
                : {}),
            }),
          record: (record) => deps.getStore().recordSessionMigration(record),
          refreshIndex: async (migrationTarget, writtenFilePath, targetSessionId) => {
            const status = await indexMigratedSessionFile(
              deps.getStore(),
              migrationTarget,
              writtenFilePath,
              targetSessionId,
            );
            deps.onIndexStatusUpdated(status);
          },
          launch: (migrationTarget, targetSessionId, projectPath, snapshot) =>
            openMigrationResumeInTerminal(migrationTarget, targetSessionId, projectPath, snapshot),
          resumeCommand: (migrationTarget, targetSessionId, projectPath, snapshot) =>
            getMigrationResumeProcessSpec(migrationTarget, targetSessionId, projectPath, snapshot).displayCommand,
          fallbackResumeCommand: (migrationTarget, targetSessionId, projectPath, snapshot) =>
            getSafeMigrationResumeCommand(migrationTarget, targetSessionId, projectPath, snapshot),
          onProgress,
          idFactory: () => randomUUID(),
          targetSessionIdFactory: () => randomUUID(),
          now: () => Date.now(),
          projectPathExists: pathExists,
          projectPathIsDirectory: pathIsDirectory,
        },
      );
    },
  };
}
