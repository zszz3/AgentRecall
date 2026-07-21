import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export type AgentMemoryKind = "agents" | "claude" | "cursor";

export interface AgentMemoryFile {
  relativePath: string;
  scopeDirectory: string;
  name: string;
  kind: AgentMemoryKind;
  size: number;
  modifiedAt: number;
}

export interface AgentMemorySnapshot {
  rootPath: string;
  selectedDirectoryPath: string;
  selectedDirectory: string;
  files: AgentMemoryFile[];
  directories: string[];
  scannedAt: number;
}

export interface AgentMemoryDocument extends AgentMemoryFile {
  content: string;
}

export interface CreateAgentMemoryInput {
  directory: string;
  kind: AgentMemoryKind;
  fileName?: string;
}

export type CreateSelectedAgentMemoryInput = Omit<CreateAgentMemoryInput, "directory">;

const MAX_MEMORY_FILE_BYTES = 1_048_576;

function normalizeAgentMemoryDirectory(value: string): string {
  if (value.includes("\0")) throw new Error("The directory must not contain NUL characters.");
  const portable = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!portable || portable === ".") return "";
  if (portable.startsWith("/") || /^[a-zA-Z]:($|\/)/.test(portable)) {
    throw new Error("The memory directory must be relative to the project.");
  }
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("The memory directory must stay inside the project.");
  }
  return segments.join("/");
}

export async function scanAgentMemoryDirectory(selectedDirectoryPath: string): Promise<AgentMemorySnapshot> {
  const selectedPath = await requireDirectory(selectedDirectoryPath);
  const rootPath = await findGitRoot(selectedPath) ?? selectedPath;
  const selectedDirectory = toPortablePath(path.relative(rootPath, selectedPath));
  const directories = directoryChain(selectedDirectory);
  const files: AgentMemoryFile[] = [];
  for (const relativeDirectory of directories) {
    const directoryPath = path.join(rootPath, ...relativeDirectory.split("/").filter(Boolean));
    await collectMemoryFile(rootPath, path.join(directoryPath, "AGENTS.md"), files);
    await collectMemoryFile(rootPath, path.join(directoryPath, "CLAUDE.md"), files);
    await collectCursorRules(rootPath, directoryPath, files);
  }

  files.sort(compareMemoryFiles);
  return {
    rootPath,
    selectedDirectoryPath: selectedPath,
    selectedDirectory,
    files,
    directories,
    scannedAt: Date.now(),
  };
}

export async function readAgentMemoryFile(projectPath: string, relativePath: string): Promise<AgentMemoryDocument> {
  const rootPath = await requireDirectory(projectPath);
  const normalizedPath = normalizeMemoryFilePath(relativePath);
  const descriptor = describeMemoryPath(normalizedPath);
  if (!descriptor) throw new Error("Only supported Agent memory files can be opened.");
  const filePath = await requireSafeExistingFile(rootPath, normalizedPath);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_MEMORY_FILE_BYTES) throw new Error("This Agent memory file is larger than 1 MB.");
  return {
    relativePath: normalizedPath,
    scopeDirectory: descriptor.scopeDirectory,
    name: path.posix.basename(normalizedPath),
    kind: descriptor.kind,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    content: await fs.readFile(filePath, "utf8"),
  };
}

export async function saveAgentMemoryFile(
  projectPath: string,
  relativePath: string,
  content: string,
): Promise<AgentMemoryDocument> {
  assertMemoryContentSize(content);
  const rootPath = await requireDirectory(projectPath);
  const normalizedPath = normalizeMemoryFilePath(relativePath);
  if (!describeMemoryPath(normalizedPath)) throw new Error("Only supported Agent memory files can be saved.");
  const filePath = await requireSafeExistingFile(rootPath, normalizedPath);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return readAgentMemoryFile(rootPath, normalizedPath);
}

export async function deleteAgentMemoryFile(projectPath: string, relativePath: string): Promise<void> {
  const rootPath = await requireDirectory(projectPath);
  const normalizedPath = normalizeMemoryFilePath(relativePath);
  if (!describeMemoryPath(normalizedPath)) throw new Error("Only supported Agent memory files can be deleted.");
  const filePath = await requireSafeExistingFile(rootPath, normalizedPath);
  await fs.unlink(filePath);
}

export async function createAgentMemoryFile(
  projectPath: string,
  input: CreateAgentMemoryInput,
): Promise<AgentMemoryDocument> {
  const rootPath = await requireDirectory(projectPath);
  const directory = normalizeAgentMemoryDirectory(input.directory);
  const scopePath = await requireSafeExistingDirectory(rootPath, directory);
  const relativePath = memoryPathForCreate(directory, input);
  const descriptor = describeMemoryPath(relativePath);
  if (!descriptor) throw new Error("Only supported Agent memory files can be created.");

  let parentPath = scopePath;
  if (input.kind === "cursor") {
    parentPath = await createSafeChildDirectories(rootPath, scopePath, [".cursor", "rules"]);
  }
  const filePath = path.join(parentPath, path.posix.basename(relativePath));
  const content = defaultMemoryContent(input.kind);
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${relativePath} already exists.`);
    }
    throw error;
  }
  return readAgentMemoryFile(rootPath, relativePath);
}

function memoryPathForCreate(directory: string, input: CreateAgentMemoryInput): string {
  const prefix = directory ? `${directory}/` : "";
  if (input.kind === "agents") return `${prefix}AGENTS.md`;
  if (input.kind === "claude") return `${prefix}CLAUDE.md`;
  const fileName = normalizeCursorRuleName(input.fileName ?? "memory");
  return `${prefix}.cursor/rules/${fileName}.mdc`;
}

function defaultMemoryContent(kind: AgentMemoryKind): string {
  if (kind === "agents") return "# Agent instructions\n\n";
  if (kind === "claude") return "# Claude Code memory\n\n";
  return "---\ndescription: Directory-specific project memory\nalwaysApply: true\n---\n\n# Cursor rule\n\n";
}

function normalizeCursorRuleName(value: string): string {
  const name = value.trim().replace(/\.mdc$/i, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || name === "." || name === "..") {
    throw new Error("Cursor rule names may contain only letters, numbers, dots, dashes, and underscores.");
  }
  return name;
}

function normalizeMemoryFilePath(value: string): string {
  if (value.includes("\0")) throw new Error("The file path must not contain NUL characters.");
  const portable = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!portable || portable.startsWith("/") || /^[a-zA-Z]:($|\/)/.test(portable)) {
    throw new Error("The memory file path must be relative to the project.");
  }
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The memory file path must stay inside the project.");
  }
  return segments.join("/");
}

function describeMemoryPath(relativePath: string): Pick<AgentMemoryFile, "kind" | "scopeDirectory"> | null {
  const segments = relativePath.split("/");
  const name = segments.at(-1);
  if (name === "AGENTS.md" || name === "CLAUDE.md") {
    return {
      kind: name === "AGENTS.md" ? "agents" : "claude",
      scopeDirectory: segments.slice(0, -1).join("/"),
    };
  }
  if (
    name?.endsWith(".mdc") &&
    segments.length >= 3 &&
    segments.at(-2) === "rules" &&
    segments.at(-3) === ".cursor"
  ) {
    return { kind: "cursor", scopeDirectory: segments.slice(0, -3).join("/") };
  }
  return null;
}

function compareMemoryFiles(left: AgentMemoryFile, right: AgentMemoryFile): number {
  const kindOrder: Record<AgentMemoryKind, number> = { agents: 0, claude: 1, cursor: 2 };
  return directoryDepth(left.scopeDirectory) - directoryDepth(right.scopeDirectory)
    || left.scopeDirectory.localeCompare(right.scopeDirectory)
    || kindOrder[left.kind] - kindOrder[right.kind]
    || left.relativePath.localeCompare(right.relativePath);
}

function directoryDepth(directory: string): number {
  return directory ? directory.split("/").length : 0;
}

function directoryChain(selectedDirectory: string): string[] {
  const chain = [""];
  if (!selectedDirectory) return chain;
  const segments = selectedDirectory.split("/");
  for (let index = 1; index <= segments.length; index += 1) chain.push(segments.slice(0, index).join("/"));
  return chain;
}

async function collectMemoryFile(rootPath: string, filePath: string, files: AgentMemoryFile[]): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  const relativePath = toPortablePath(path.relative(rootPath, filePath));
  const descriptor = describeMemoryPath(relativePath);
  if (!descriptor) return;
  files.push({
    relativePath,
    scopeDirectory: descriptor.scopeDirectory,
    name: path.basename(filePath),
    kind: descriptor.kind,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  });
}

async function collectCursorRules(rootPath: string, directoryPath: string, files: AgentMemoryFile[]): Promise<void> {
  const cursorPath = path.join(directoryPath, ".cursor");
  const rulesPath = path.join(cursorPath, "rules");
  try {
    const cursorStat = await fs.lstat(cursorPath);
    const rulesStat = await fs.lstat(rulesPath);
    if (cursorStat.isSymbolicLink() || rulesStat.isSymbolicLink() || !rulesStat.isDirectory()) return;
    const entries = await fs.readdir(rulesPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".mdc")) continue;
      await collectMemoryFile(rootPath, path.join(rulesPath, entry.name), files);
    }
  } catch {
    // The selected directory does not have Cursor rules, or they are unreadable.
  }
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function requireDirectory(projectPath: string): Promise<string> {
  if (!projectPath || projectPath.includes("\0")) throw new Error("A valid project path is required.");
  const rootPath = await fs.realpath(path.resolve(projectPath));
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) throw new Error("The selected project path is not a directory.");
  return rootPath;
}

async function findGitRoot(selectedPath: string): Promise<string | null> {
  let currentPath = selectedPath;
  while (true) {
    try {
      const marker = await fs.lstat(path.join(currentPath, ".git"));
      if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return currentPath;
    } catch {
      // Continue toward the filesystem root when this directory is not a Git root.
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

async function requireSafeExistingDirectory(rootPath: string, relativeDirectory: string): Promise<string> {
  const targetPath = path.join(rootPath, ...relativeDirectory.split("/").filter(Boolean));
  const realTarget = await fs.realpath(targetPath);
  if (!isPathInside(rootPath, realTarget)) throw new Error("The memory directory must stay inside the project.");
  const stat = await fs.stat(realTarget);
  if (!stat.isDirectory()) throw new Error("The selected memory directory does not exist.");
  return realTarget;
}

async function requireSafeExistingFile(rootPath: string, relativePath: string): Promise<string> {
  const targetPath = path.join(rootPath, ...relativePath.split("/"));
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be edited as Agent memory files.");
  const realTarget = await fs.realpath(targetPath);
  if (!isPathInside(rootPath, realTarget)) throw new Error("The Agent memory file must stay inside the project.");
  if (!stat.isFile()) throw new Error("The selected Agent memory path is not a file.");
  return realTarget;
}

async function createSafeChildDirectories(rootPath: string, basePath: string, segments: string[]): Promise<string> {
  let currentPath = basePath;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    try {
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be used for Agent memory directories.");
      if (!stat.isDirectory()) throw new Error("The Agent memory directory path is occupied by a file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(currentPath);
    }
    const realCurrent = await fs.realpath(currentPath);
    if (!isPathInside(rootPath, realCurrent)) throw new Error("The memory directory must stay inside the project.");
  }
  return currentPath;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertMemoryContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_FILE_BYTES) {
    throw new Error("Agent memory content cannot exceed 1 MB.");
  }
}
