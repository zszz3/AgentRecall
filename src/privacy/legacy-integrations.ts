import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type LegacyIntegrationKind = "mcp" | "hook" | "statusline";
export type LegacyIntegrationClient = "claude" | "codex" | "codebuddy";

export interface LegacyIntegrationFinding {
  id: string;
  kind: LegacyIntegrationKind;
  client: LegacyIntegrationClient;
  filePath: string;
  locator: string;
  description: string;
}

export interface LegacyIntegrationIssue {
  filePath: string;
  error: string;
}

export interface LegacyIntegrationInspection {
  homeDir: string;
  findings: LegacyIntegrationFinding[];
  issues: LegacyIntegrationIssue[];
}

export interface LegacyCleanupAction {
  filePath: string;
  findingIds: string[];
  originalSha256: string;
  description: string;
}

export interface LegacyCleanupPlan {
  schemaVersion: 1;
  planId: string;
  createdAt: string;
  homeDir: string;
  backupRoot: string;
  confirmationToken: string;
  actions: LegacyCleanupAction[];
  issues: LegacyIntegrationIssue[];
}

export interface LegacyCleanupResult {
  planId: string;
  backupDirectory: string | null;
  changedFiles: string[];
  removedFindingIds: string[];
}

interface ConfigCandidate {
  client: LegacyIntegrationClient;
  relativePath: string;
  format: "json" | "toml";
}

interface InspectedFile {
  candidate: ConfigCandidate;
  filePath: string;
  content: string;
  mode: number;
  findings: LegacyIntegrationFinding[];
  cleanedContent: string;
}

const CANDIDATES: readonly ConfigCandidate[] = [
  { client: "claude", relativePath: ".claude.json", format: "json" },
  { client: "claude", relativePath: path.join(".claude", "settings.json"), format: "json" },
  { client: "codex", relativePath: path.join(".codex", "config.toml"), format: "toml" },
  { client: "codex", relativePath: path.join(".codex", "hooks.json"), format: "json" },
  { client: "codebuddy", relativePath: path.join(".codebuddy", "mcp.json"), format: "json" },
];

const OWNED_COMMAND_MARKERS = [
  "agent-recall-mcp",
  "agent-recall-session-sync",
  "session-sync-record.cjs",
  "agent-recall-skill-usage",
  "skill-usage-record.cjs",
  "agent-recall-claude-statusline",
  "claude-statusline-snapshot.cjs",
] as const;
const SAFE_PLAN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isOwnedCommand(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return OWNED_COMMAND_MARKERS.some((marker) => normalized.includes(marker));
}

function finding(
  candidate: ConfigCandidate,
  filePath: string,
  kind: LegacyIntegrationKind,
  locator: string,
  description: string,
): LegacyIntegrationFinding {
  return {
    id: `${candidate.client}:${kind}:${candidate.relativePath.replaceAll(path.sep, "/")}:${locator}`,
    kind,
    client: candidate.client,
    filePath,
    locator,
    description,
  };
}

function removeOwnedHooks(
  candidate: ConfigCandidate,
  filePath: string,
  root: Record<string, unknown>,
): LegacyIntegrationFinding[] {
  if (!isRecord(root.hooks)) return [];
  const findings: LegacyIntegrationFinding[] = [];

  for (const [eventName, rawEntries] of Object.entries(root.hooks)) {
    if (!Array.isArray(rawEntries)) continue;
    const keptEntries: unknown[] = [];

    rawEntries.forEach((rawEntry, entryIndex) => {
      if (!isRecord(rawEntry) || !Array.isArray(rawEntry.hooks)) {
        keptEntries.push(rawEntry);
        return;
      }
      const keptHooks = rawEntry.hooks.filter((rawHook, hookIndex) => {
        if (!isRecord(rawHook) || !isOwnedCommand(rawHook.command)) return true;
        findings.push(finding(
          candidate,
          filePath,
          "hook",
          `hooks.${eventName}[${entryIndex}].hooks[${hookIndex}]`,
          `Remove the AgentRecall ${eventName} hook from ${candidate.client}.`,
        ));
        return false;
      });
      if (keptHooks.length > 0) keptEntries.push({ ...rawEntry, hooks: keptHooks });
    });

    if (keptEntries.length > 0) root.hooks[eventName] = keptEntries;
    else delete root.hooks[eventName];
  }

  if (Object.keys(root.hooks).length === 0) delete root.hooks;
  return findings;
}

function inspectJson(
  candidate: ConfigCandidate,
  filePath: string,
  content: string,
  mode: number,
): InspectedFile {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error("Configuration is not a JSON object.");

  const findings: LegacyIntegrationFinding[] = [];
  if (isRecord(parsed.mcpServers) && Object.hasOwn(parsed.mcpServers, "agent-recall")) {
    findings.push(finding(
      candidate,
      filePath,
      "mcp",
      "mcpServers.agent-recall",
      `Remove only the AgentRecall MCP server entry from ${candidate.client}.`,
    ));
    delete parsed.mcpServers["agent-recall"];
    if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;
  }

  if (
    candidate.client === "claude"
    && isRecord(parsed.statusLine)
    && isOwnedCommand(parsed.statusLine.command)
  ) {
    findings.push(finding(
      candidate,
      filePath,
      "statusline",
      "statusLine",
      "Remove the AgentRecall Claude status line command.",
    ));
    delete parsed.statusLine;
  }

  findings.push(...removeOwnedHooks(candidate, filePath, parsed));
  const cleanedContent = findings.length > 0 ? `${JSON.stringify(parsed, null, 2)}\n` : content;
  return { candidate, filePath, content, mode, findings, cleanedContent };
}

function tomlLineChunks(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
}

function inspectToml(
  candidate: ConfigCandidate,
  filePath: string,
  content: string,
  mode: number,
): InspectedFile {
  const chunks = tomlLineChunks(content);
  const findings: LegacyIntegrationFinding[] = [];
  const kept: string[] = [];
  let removingOwnedSection = false;

  for (const chunk of chunks) {
    const line = chunk.replace(/[\r\n]+$/, "");
    if (/^\s*\[mcp_servers\.agent_recall\]\s*(?:#.*)?$/i.test(line)) {
      findings.push(finding(
        candidate,
        filePath,
        "mcp",
        "mcp_servers.agent_recall",
        "Remove only the AgentRecall MCP server table from Codex.",
      ));
      removingOwnedSection = true;
      continue;
    }
    if (removingOwnedSection && /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) {
      removingOwnedSection = false;
    }
    if (!removingOwnedSection) kept.push(chunk);
  }

  return {
    candidate,
    filePath,
    content,
    mode,
    findings,
    cleanedContent: findings.length > 0 ? kept.join("") : content,
  };
}

function validateRoot(root: string, label: string): string {
  if (!path.isAbsolute(root)) throw new Error(`${label} must be an absolute path.`);
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root) throw new Error(`${label} cannot be a filesystem root.`);
  return normalized;
}

function validatePlanId(planId: string): string {
  if (!SAFE_PLAN_ID.test(planId) || planId.includes("..")) {
    throw new Error("Legacy cleanup planId must contain only safe filename characters.");
  }
  return planId;
}

function confirmationTokenFor(plan: Omit<LegacyCleanupPlan, "schemaVersion" | "confirmationToken" | "issues">): string {
  const digest = sha256(JSON.stringify({
    planId: plan.planId,
    createdAt: plan.createdAt,
    homeDir: plan.homeDir,
    backupRoot: plan.backupRoot,
    actions: plan.actions,
  }));
  return `remove-agent-recall-${digest.slice(0, 16)}`;
}

function resolveCandidate(homeDir: string, relativePath: string): string {
  const filePath = path.resolve(homeDir, relativePath);
  const relative = path.relative(homeDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("A legacy integration path escaped the supplied home directory.");
  }
  return filePath;
}

async function assertRootIsNotSymlink(root: string, label: string): Promise<void> {
  try {
    if ((await fs.lstat(root)).isSymbolicLink()) {
      throw new Error(`${label} cannot be a symbolic link.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertCandidateHasNoSymlink(
  homeDir: string,
  filePath: string,
): Promise<void> {
  const relative = path.relative(homeDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("A legacy integration path escaped the supplied home directory.");
  }
  let current = homeDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(
          "Legacy integration cleanup refuses symbolic links beneath the supplied home directory.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function inspectFiles(homeDirInput: string): Promise<{
  homeDir: string;
  files: InspectedFile[];
  issues: LegacyIntegrationIssue[];
}> {
  const homeDir = validateRoot(homeDirInput, "homeDir");
  await assertRootIsNotSymlink(homeDir, "homeDir");
  const files: InspectedFile[] = [];
  const issues: LegacyIntegrationIssue[] = [];

  for (const candidate of CANDIDATES) {
    const filePath = resolveCandidate(homeDir, candidate.relativePath);
    let content: string;
    try {
      await assertCandidateHasNoSymlink(homeDir, filePath);
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      issues.push({ filePath, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    try {
      const mode = (await fs.stat(filePath)).mode & 0o777;
      files.push(candidate.format === "json"
        ? inspectJson(candidate, filePath, content, mode)
        : inspectToml(candidate, filePath, content, mode));
    } catch (error) {
      issues.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { homeDir, files, issues };
}

/** Read-only detection. It never creates, rewrites, or removes a file. */
export async function inspectLegacyIntegrations(
  options: { homeDir: string },
): Promise<LegacyIntegrationInspection> {
  const inspected = await inspectFiles(options.homeDir);
  return {
    homeDir: inspected.homeDir,
    findings: inspected.files.flatMap((file) => file.findings),
    issues: inspected.issues,
  };
}

/**
 * Produces a stable, reviewable plan without writing a backup or config file.
 * The caller must display the actions and pass the exact confirmation token to
 * applyLegacyCleanup in a later, explicit user action.
 */
export async function previewLegacyCleanup(options: {
  homeDir: string;
  backupRoot: string;
  now?: Date;
  idFactory?: () => string;
}): Promise<LegacyCleanupPlan> {
  const inspected = await inspectFiles(options.homeDir);
  const backupRoot = validateRoot(options.backupRoot, "backupRoot");
  await assertRootIsNotSymlink(backupRoot, "backupRoot");
  const planId = validatePlanId((options.idFactory ?? randomUUID)());
  const createdAt = (options.now ?? new Date()).toISOString();
  const actions = inspected.files
    .filter((file) => file.findings.length > 0)
    .map((file) => ({
      filePath: file.filePath,
      findingIds: file.findings.map((item) => item.id),
      originalSha256: sha256(file.content),
      description: file.findings.map((item) => item.description).join(" "),
    }));
  const tokenInput = {
    planId,
    createdAt,
    homeDir: inspected.homeDir,
    backupRoot,
    actions,
  };

  return {
    schemaVersion: 1,
    planId,
    createdAt,
    homeDir: inspected.homeDir,
    backupRoot,
    confirmationToken: confirmationTokenFor(tokenInput),
    actions,
    issues: inspected.issues,
  };
}

async function writeAtomic(
  filePath: string,
  content: string,
  originalMode: number,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const safeMode = originalMode & 0o600 || 0o600;
  await fs.writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: safeMode,
  });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Applies only a previously previewed set of removals. Every source hash is
 * rechecked before backup/write, preventing a stale plan from overwriting edits.
 */
export async function applyLegacyCleanup(
  plan: LegacyCleanupPlan,
  confirmationToken: string,
): Promise<LegacyCleanupResult> {
  if (plan.schemaVersion !== 1) throw new Error("Unsupported legacy cleanup plan.");
  const planId = validatePlanId(plan.planId);
  const expectedToken = confirmationTokenFor({
    planId,
    createdAt: plan.createdAt,
    homeDir: plan.homeDir,
    backupRoot: plan.backupRoot,
    actions: plan.actions,
  });
  if (
    !confirmationToken
    || confirmationToken !== plan.confirmationToken
    || confirmationToken !== expectedToken
  ) {
    throw new Error("Legacy cleanup confirmation token does not match the preview.");
  }

  const homeDir = validateRoot(plan.homeDir, "homeDir");
  const backupRoot = validateRoot(plan.backupRoot, "backupRoot");
  await assertRootIsNotSymlink(homeDir, "homeDir");
  await assertRootIsNotSymlink(backupRoot, "backupRoot");
  const current = await inspectFiles(homeDir);
  if (current.issues.length > 0) {
    throw new Error(`Legacy cleanup stopped because ${current.issues.length} config file(s) could not be inspected.`);
  }
  const filesByPath = new Map(current.files.map((file) => [file.filePath, file]));
  const prepared = plan.actions.map((action) => {
    const relative = path.relative(homeDir, action.filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Legacy cleanup plan contains a path outside the supplied home directory.");
    }
    const file = filesByPath.get(action.filePath);
    if (!file || sha256(file.content) !== action.originalSha256) {
      throw new Error(`Legacy cleanup preview is stale for ${action.filePath}. Run preview again.`);
    }
    const currentIds = file.findings.map((item) => item.id);
    if (
      currentIds.length !== action.findingIds.length
      || currentIds.some((id, index) => id !== action.findingIds[index])
    ) {
      throw new Error(`Legacy cleanup findings changed for ${action.filePath}. Run preview again.`);
    }
    return { action, file, relative };
  });

  if (prepared.length === 0) {
    return { planId: plan.planId, backupDirectory: null, changedFiles: [], removedFindingIds: [] };
  }

  const createdAt = new Date(plan.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error("Legacy cleanup plan has an invalid creation time.");
  const timestamp = createdAt.toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.resolve(backupRoot, `${timestamp}-${planId}`);
  const backupRelative = path.relative(backupRoot, backupDirectory);
  if (!backupRelative || backupRelative.startsWith("..") || path.isAbsolute(backupRelative)) {
    throw new Error("Legacy cleanup backup directory escaped the supplied backup root.");
  }
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(backupRoot, 0o700);
  await fs.mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  for (const item of prepared) {
    await assertCandidateHasNoSymlink(homeDir, item.file.filePath);
    const backupPath = path.join(backupDirectory, item.relative);
    const backupParent = path.dirname(backupPath);
    await fs.mkdir(backupParent, { recursive: true, mode: 0o700 });
    await fs.chmod(backupParent, 0o700);
    await fs.writeFile(backupPath, item.file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  const changedFiles: string[] = [];
  try {
    for (const item of prepared) {
      await assertCandidateHasNoSymlink(homeDir, item.file.filePath);
      await writeAtomic(
        item.file.filePath,
        item.file.cleanedContent,
        item.file.mode,
      );
      changedFiles.push(item.file.filePath);
    }
  } catch (error) {
    for (const changedFile of changedFiles) {
      const item = prepared.find((candidate) => candidate.file.filePath === changedFile);
      if (item) {
        await writeAtomic(
          changedFile,
          item.file.content,
          item.file.mode,
        ).catch(() => undefined);
      }
    }
    throw error;
  }

  return {
    planId: plan.planId,
    backupDirectory,
    changedFiles,
    removedFindingIds: prepared.flatMap((item) => item.action.findingIds),
  };
}
