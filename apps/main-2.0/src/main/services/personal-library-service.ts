import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { LIBRARY_AGENT_IDS, type LibraryAgentId } from "../../core/library-agent-ids";
import { resolveLibraryAgents, type LibraryAgent } from "../../core/library-agents";
import { decodeServer, encodeServer, libraryMcpTargets, readMcpEntries, withMcpEntries, type LibraryMcpTarget } from "../../core/library-mcp";
import { LIBRARY_MCP_NAME, RESERVED_MCP_NAME, type LibraryMcpServer, type LibraryMcpServers } from "../../core/library-mcp-server";
import {
  libraryMcpServersSchema,
  type LibraryAgentState,
  type LibraryAgentStatus,
  type LibraryImportCandidate,
  type LibraryMcpAgentStatus,
  type LibraryMcpImportCandidate,
  type LibraryMcpPreview,
  type LibraryPreview,
  type PersonalLibrarySnapshot,
} from "../../shared/ipc/personal-library";
import { hasMagpieBlock, ownedBlock, personalParagraphs, withOwnedBlock, withoutParagraphs } from "../../core/library-instructions";

interface LibraryState {
  schemaVersion: 1;
  enabled: LibraryAgentId[];
  /** Library block body last written to each file, keyed by absolute path. */
  written: Record<string, string>;
  /** Files already backed up before AgentRecall first changed them. */
  backedUp: string[];
  mcp: {
    enabled: LibraryAgentId[];
    /** MCP entries last written to each file by server name, in the agent's own shape. */
    written: Record<string, Record<string, unknown>>;
  };
}

const KEEP_BACKUPS = 30;
const emptyState = (): LibraryState => ({ schemaVersion: 1, enabled: [], written: {}, backedUp: [], mcp: { enabled: [], written: {} } });

/** Changes one sync makes to an agent's MCP file. */
interface McpPlan {
  set: Record<string, unknown>;
  remove: string[];
  add: string[];
  update: string[];
  conflicts: string[];
  record: Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function changedOutside(file: string): Error {
  return new Error(`The AgentRecall Library block in ${file} was changed outside AgentRecall. Choose whether to keep the file's version or overwrite it, then try again.`);
}

/**
 * The personal Library's instructions and the agents they are written to.
 * Every change goes through one queue so two requests never interleave writes
 * to the same files.
 */
export class PersonalLibraryService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { root: string; home: string; env: Record<string, string | undefined> }) {}

  snapshot(): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => this.describe(await this.readInstructions(), await this.readState()));
  }

  saveInstructions(text: string): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const state = await this.readState();
      await this.readInstructions();
      return this.store(text.trim(), state);
    });
  }

  preview(id: LibraryAgentId, enabled: boolean): Promise<LibraryPreview> {
    return this.serial(async () => {
      const instructions = await this.readInstructions();
      const state = await this.readState();
      const { agents, file } = await this.target(id);
      const before = await readText(file) ?? "";
      const shared = this.sharers(agents, state, file).some((other) => other !== id);
      const after = enabled ? withOwnedBlock(before, instructions || null) : shared ? before : withOwnedBlock(before, null);
      return { file, before, after };
    });
  }

  setAgentEnabled(id: LibraryAgentId, enabled: boolean): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const instructions = await this.readInstructions();
      const state = await this.readState();
      const { agents, agent, file } = await this.target(id);
      const current = await readText(file);
      const others = this.sharers(agents, state, file).filter((other) => other !== id);
      if (enabled && current !== null && hasMagpieBlock(current)) {
        throw new Error(`${file} is managed by magpie. Turn off magpie's Library for ${agent.name} before AgentRecall writes it.`);
      }
      if (enabled || others.length === 0) this.ensureUnchanged(file, current, state);
      if (enabled) {
        if (!state.enabled.includes(id)) state.enabled.push(id);
        await this.write(file, current, instructions || null, state);
      } else {
        state.enabled = state.enabled.filter((other) => other !== id);
        if (others.length === 0) await this.write(file, current, null, state);
      }
      await this.saveState(state);
      return this.describe(instructions, state);
    });
  }

  resolveConflict(id: LibraryAgentId, choice: "use-file" | "overwrite"): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const instructions = await this.readInstructions();
      const state = await this.readState();
      const { file } = await this.target(id);
      const current = await readText(file) ?? "";
      if (!state.enabled.includes(id)) state.enabled.push(id);
      if (choice === "use-file") {
        const body = ownedBlock(current) ?? "";
        if (body) state.written[file] = body;
        else delete state.written[file];
        return this.store(body, state);
      }
      await this.backup(file, current);
      if (!state.backedUp.includes(file)) state.backedUp.push(file);
      await this.write(file, current, instructions || null, state);
      await this.saveState(state);
      return this.describe(instructions, state);
    });
  }

  importCandidates(): Promise<LibraryImportCandidate[]> {
    return this.serial(async () => {
      const library = new Set(personalParagraphs(await this.readInstructions()));
      const candidates = new Map<string, LibraryAgentId[]>();
      for (const agent of await this.agents()) {
        const text = agent.instructions ? await readText(agent.instructions) : null;
        if (!text) continue;
        for (const paragraph of personalParagraphs(text)) {
          if (library.has(paragraph)) continue;
          const owners = candidates.get(paragraph) ?? [];
          if (!owners.includes(agent.id)) owners.push(agent.id);
          candidates.set(paragraph, owners);
        }
      }
      return [...candidates].map(([text, agents]) => ({ text, agents }));
    });
  }

  /** Adds the chosen paragraphs to the Library; with `removeFromSources`, backs up each agent file holding them and takes them out. */
  importParagraphs(texts: readonly string[], removeFromSources: boolean): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const instructions = await this.readInstructions();
      const state = await this.readState();
      const chosen = new Set(texts.flatMap((text) => personalParagraphs(text)));
      const existing = new Set(personalParagraphs(instructions));
      const added = [...chosen].filter((paragraph) => !existing.has(paragraph));
      if (removeFromSources) {
        const files = new Set((await this.agents()).flatMap((agent) => agent.instructions ? [agent.instructions] : []));
        for (const file of files) {
          const text = await readText(file);
          if (!text || !personalParagraphs(text).some((paragraph) => chosen.has(paragraph))) continue;
          await this.backup(file, text);
          await writeAtomically(file, withoutParagraphs(text, chosen));
        }
      }
      return this.store([instructions, ...added].filter(Boolean).join("\n\n"), state);
    });
  }

  /** Replaces the Library's MCP servers and updates every agent turned on, except entries changed outside AgentRecall. */
  saveMcpServers(servers: LibraryMcpServers): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const state = await this.readState();
      await this.readMcp();
      return this.storeMcp(servers, state);
    });
  }

  previewMcp(id: LibraryAgentId, enabled: boolean): Promise<LibraryMcpPreview> {
    return this.serial(async () => {
      const servers = await this.readMcp();
      const state = await this.readState();
      const target = this.mcpTarget(id);
      const plan = this.planMcp(target, await readText(target.file), enabled ? servers : {}, state.mcp.written[target.file] ?? {}, false);
      return { file: target.file, add: plan.add, update: plan.update, remove: plan.remove, conflicts: plan.conflicts };
    });
  }

  setMcpAgentEnabled(id: LibraryAgentId, enabled: boolean): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const servers = await this.readMcp();
      const state = await this.readState();
      const target = this.mcpTarget(id);
      if (enabled) {
        if (!state.mcp.enabled.includes(id)) state.mcp.enabled.push(id);
        await this.applyMcp(target, servers, state, false);
      } else {
        state.mcp.enabled = state.mcp.enabled.filter((other) => other !== id);
        // Entries edited outside AgentRecall stay in the file; AgentRecall stops tracking them.
        await this.applyMcp(target, {}, state, false);
        delete state.mcp.written[target.file];
      }
      await this.saveState(state);
      return this.describe(await this.readInstructions(), state);
    });
  }

  /** Backs up the agent's MCP file and writes every Library server into it, replacing same-named entries. */
  overwriteMcp(id: LibraryAgentId): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const servers = await this.readMcp();
      const state = await this.readState();
      const target = this.mcpTarget(id);
      const current = await readText(target.file);
      if (current !== null) await this.backup(target.file, current);
      if (!state.mcp.enabled.includes(id)) state.mcp.enabled.push(id);
      await this.applyMcp(target, servers, state, true);
      await this.saveState(state);
      return this.describe(await this.readInstructions(), state);
    });
  }

  mcpImportCandidates(): Promise<LibraryMcpImportCandidate[]> {
    return this.serial(async () => {
      const library = await this.readMcp();
      const state = await this.readState();
      const candidates = new Map<string, LibraryMcpImportCandidate>();
      for (const target of this.mcpTargets()) {
        const text = await readText(target.file);
        if (!text) continue;
        let entries: Record<string, unknown>;
        try {
          entries = readMcpEntries(target, text);
        } catch {
          // An unreadable file is reported on the agent's row; the other agents can still be imported.
          continue;
        }
        const recorded = state.mcp.written[target.file] ?? {};
        for (const [name, value] of Object.entries(entries)) {
          if (name === RESERVED_MCP_NAME || !LIBRARY_MCP_NAME.test(name)) continue;
          if (has(recorded, name) && same(value, recorded[name])) continue;
          const server = decodeServer(target, target.format === "codex" ? this.codexTable(value, name) : value);
          if (!server || (has(library, name) && same(library[name], server))) continue;
          const key = `${name}\n${canonical(server)}`;
          const candidate = candidates.get(key) ?? { name, server, agents: [] };
          candidate.agents.push(target.id);
          candidates.set(key, candidate);
        }
      }
      return [...candidates.values()];
    });
  }

  importMcpServers(chosen: ReadonlyArray<{ name: string; server: LibraryMcpServer }>): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const servers = { ...await this.readMcp() };
      const state = await this.readState();
      for (const { name, server } of chosen) {
        if (has(servers, name) && !same(servers[name], server)) {
          throw new Error(`The Library already has a server named "${name}". Rename one of them before importing.`);
        }
        servers[name] = server;
      }
      return this.storeMcp(servers, state);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    // The queue only orders operations; each caller receives its own failure.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private get instructionsFile(): string {
    return path.join(this.options.root, "instructions.md");
  }

  private async readInstructions(): Promise<string> {
    try {
      return (await readText(this.instructionsFile) ?? "").trim();
    } catch (error) {
      throw new Error(`Could not read the Library instructions at ${this.instructionsFile}: ${(error as Error).message}. Nothing was written to the agents.`);
    }
  }

  private async readState(): Promise<LibraryState> {
    const file = path.join(this.options.root, "state.json");
    let parsed: Partial<LibraryState>;
    try {
      const text = await readText(file);
      if (text === null) return emptyState();
      parsed = JSON.parse(text) as Partial<LibraryState>;
    } catch (error) {
      throw new Error(`Could not read the Library state at ${file}: ${(error as Error).message}. Nothing was written to the agents.`);
    }
    if (parsed.schemaVersion !== 1) throw new Error(`The Library state at ${file} has an unknown format. Nothing was written to the agents.`);
    return { ...emptyState(), ...parsed, mcp: { ...emptyState().mcp, ...parsed.mcp }, schemaVersion: 1 };
  }

  private saveState(state: LibraryState): Promise<void> {
    return writeAtomically(path.join(this.options.root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  private agents(): Promise<LibraryAgent[]> {
    return resolveLibraryAgents(this.options.home, this.options.env);
  }

  private async target(id: LibraryAgentId): Promise<{ agents: LibraryAgent[]; agent: LibraryAgent; file: string }> {
    const agents = await this.agents();
    const agent = agents.find((item) => item.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}.`);
    if (!agent.instructions) throw new Error(`${agent.name} has no user-level instructions file.`);
    return { agents, agent, file: agent.instructions };
  }

  /** Enabled agents that read `file`. */
  private sharers(agents: readonly LibraryAgent[], state: LibraryState, file: string): LibraryAgentId[] {
    return agents.filter((agent) => agent.instructions === file && state.enabled.includes(agent.id)).map((agent) => agent.id);
  }

  private ensureUnchanged(file: string, text: string | null, state: LibraryState): void {
    let block: string | null;
    try {
      block = text === null ? null : ownedBlock(text);
    } catch {
      // A broken block is an edit made outside AgentRecall; the user decides which version wins.
      throw changedOutside(file);
    }
    if (block !== (state.written[file] ?? null)) throw changedOutside(file);
  }

  /** Saves the instructions and rewrites every enabled agent's file that still holds AgentRecall's last version. */
  private async store(instructions: string, state: LibraryState): Promise<PersonalLibrarySnapshot> {
    await writeAtomically(this.instructionsFile, instructions ? `${instructions}\n` : "");
    const agents = await this.agents();
    const files = new Set(agents.filter((agent) => agent.instructions && state.enabled.includes(agent.id)).map((agent) => agent.instructions!));
    for (const file of files) {
      const text = await readText(file);
      if (text !== null && hasMagpieBlock(text)) continue;
      try {
        this.ensureUnchanged(file, text, state);
      } catch {
        // Left as a conflict for the user; the other agents are still updated.
        continue;
      }
      await this.write(file, text, instructions || null, state);
    }
    await this.saveState(state);
    return this.describe(instructions, state, agents);
  }

  private async write(file: string, current: string | null, body: string | null, state: LibraryState): Promise<void> {
    const next = withOwnedBlock(current ?? "", body);
    if (body) state.written[file] = body.trim();
    else delete state.written[file];
    if (next === (current ?? "") || (current === null && next === "")) return;
    if (current !== null && !state.backedUp.includes(file)) {
      await this.backup(file, current);
      state.backedUp.push(file);
    }
    await writeAtomically(file, next);
  }

  /** Copies a file into the Library's backups before AgentRecall changes it, keeping the newest 30. */
  private async backup(file: string, text: string): Promise<void> {
    const directory = path.join(this.options.root, "backups");
    const target = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, path.basename(file)), text);
    await fs.writeFile(path.join(target, "source.json"), `${JSON.stringify({ path: file }, null, 2)}\n`);
    const entries = (await fs.readdir(directory)).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
      await fs.rm(path.join(directory, old), { recursive: true, force: true });
    }
  }

  private async describe(instructions: string, state: LibraryState, known?: LibraryAgent[]): Promise<PersonalLibrarySnapshot> {
    const agents = known ?? await this.agents();
    const statuses: LibraryAgentStatus[] = [];
    for (const agent of agents) {
      const enabled = state.enabled.includes(agent.id);
      statuses.push({
        id: agent.id,
        name: agent.name,
        installed: agent.installed,
        enabled,
        state: await this.stateOf(agent, agents, state, enabled),
        file: agent.instructions,
        override: agent.override,
      });
    }
    return { instructions, agents: statuses, mcp: await this.describeMcp(state, agents) };
  }

  private async stateOf(agent: LibraryAgent, agents: readonly LibraryAgent[], state: LibraryState, enabled: boolean): Promise<LibraryAgentState> {
    const file = agent.instructions;
    if (!file) return "unsupported";
    const text = await readText(file);
    if (text !== null && hasMagpieBlock(text)) return "magpie";
    let block: string | null;
    try {
      block = text === null ? null : ownedBlock(text);
    } catch {
      // Shown as a conflict; resolving it reports the broken block in detail.
      return "conflict";
    }
    if (enabled) return block === (state.written[file] ?? null) ? "synced" : "conflict";
    if (this.sharers(agents, state, file).length > 0) return "off";
    return block === null ? "off" : "conflict";
  }

  private get mcpFile(): string {
    return path.join(this.options.root, "mcp.json");
  }

  private async readMcp(): Promise<LibraryMcpServers> {
    try {
      const text = await readText(this.mcpFile);
      if (text === null || !text.trim()) return {};
      const parsed = JSON.parse(text) as { servers?: unknown };
      return libraryMcpServersSchema.parse(parsed.servers ?? {});
    } catch (error) {
      throw new Error(`Could not read the Library MCP servers at ${this.mcpFile}: ${(error as Error).message}. Nothing was written to the agents.`);
    }
  }

  private mcpTargets(): LibraryMcpTarget[] {
    return libraryMcpTargets(this.options.home, this.options.env);
  }

  private mcpTarget(id: LibraryAgentId): LibraryMcpTarget {
    const target = this.mcpTargets().find((item) => item.id === id);
    if (!target) throw new Error(`AgentRecall cannot write MCP servers for ${id}.`);
    return target;
  }

  private codexTable(block: unknown, name: string): unknown {
    if (typeof block !== "string") return block;
    try {
      return (parseToml(block) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.[name] ?? null;
    } catch {
      // A block that only parses inside the whole file cannot be imported on its own.
      return null;
    }
  }

  /**
   * What syncing `servers` into one file would change. Entries AgentRecall wrote
   * and nobody changed are updated or removed; anything else with a Library
   * name is a conflict unless `force` replaces it.
   */
  private planMcp(target: LibraryMcpTarget, text: string | null, servers: LibraryMcpServers, record: Record<string, unknown>, force: boolean): McpPlan {
    const entries = readMcpEntries(target, text ?? "");
    const plan: McpPlan = { set: {}, remove: [], add: [], update: [], conflicts: [], record: { ...record } };
    for (const name of Object.keys(record)) {
      if (has(servers, name)) continue;
      if (!has(entries, name)) delete plan.record[name];
      else if (force || same(entries[name], record[name])) {
        plan.remove.push(name);
        delete plan.record[name];
      } else plan.conflicts.push(name);
    }
    for (const [name, server] of Object.entries(servers)) {
      const entry = encodeServer(target, name, server);
      const present = has(entries, name);
      if (present && same(entries[name], entry)) {
        plan.record[name] = entry;
        continue;
      }
      const ours = has(record, name) && present && same(entries[name], record[name]);
      if (!force && !ours && (present || has(record, name))) {
        plan.conflicts.push(name);
        continue;
      }
      plan.set[name] = entry;
      plan.record[name] = entry;
      (present ? plan.update : plan.add).push(name);
    }
    return plan;
  }

  private async applyMcp(target: LibraryMcpTarget, servers: LibraryMcpServers, state: LibraryState, force: boolean): Promise<string[]> {
    const current = await readText(target.file);
    const plan = this.planMcp(target, current, servers, state.mcp.written[target.file] ?? {}, force);
    if (Object.keys(plan.set).length > 0 || plan.remove.length > 0) {
      const next = withMcpEntries(target, current ?? "", { set: plan.set, remove: plan.remove });
      if (current !== null && !state.backedUp.includes(target.file)) {
        await this.backup(target.file, current);
        state.backedUp.push(target.file);
      }
      await writeAtomically(target.file, next);
    }
    if (Object.keys(plan.record).length > 0) state.mcp.written[target.file] = plan.record;
    else delete state.mcp.written[target.file];
    return plan.conflicts;
  }

  private async storeMcp(servers: LibraryMcpServers, state: LibraryState): Promise<PersonalLibrarySnapshot> {
    for (const name of Object.keys(servers)) {
      if (name === RESERVED_MCP_NAME) throw new Error(`"${RESERVED_MCP_NAME}" is AgentRecall's own MCP server. Choose another name.`);
      if (!LIBRARY_MCP_NAME.test(name)) throw new Error(`"${name}" cannot be used as an MCP server name. Use up to 64 letters, digits, "-" or "_".`);
    }
    const valid = libraryMcpServersSchema.parse(servers);
    await writeAtomically(this.mcpFile, `${JSON.stringify({ servers: valid }, null, 2)}\n`);
    for (const target of this.mcpTargets()) {
      if (!state.mcp.enabled.includes(target.id)) continue;
      try {
        await this.applyMcp(target, valid, state, false);
      } catch {
        // An unreadable agent file is shown on its row; the other agents are still updated.
        continue;
      }
    }
    await this.saveState(state);
    return this.describe(await this.readInstructions(), state);
  }

  private async describeMcp(state: LibraryState, agents: readonly LibraryAgent[]): Promise<PersonalLibrarySnapshot["mcp"]> {
    let servers: LibraryMcpServers;
    try {
      servers = await this.readMcp();
    } catch {
      // The instructions half of the page still loads; every MCP action reports the unreadable file.
      servers = {};
    }
    const targets = new Map(this.mcpTargets().map((target) => [target.id, target]));
    const statuses: LibraryMcpAgentStatus[] = [];
    for (const id of LIBRARY_AGENT_IDS) {
      const agent = agents.find((item) => item.id === id);
      const target = targets.get(id);
      const enabled = state.mcp.enabled.includes(id);
      const base = { id, name: agent?.name ?? id, installed: agent?.installed ?? false, enabled, file: target?.file ?? null, conflicts: [] as string[], problem: null as string | null };
      if (!target) {
        statuses.push({ ...base, state: "unsupported" });
        continue;
      }
      if (!enabled) {
        statuses.push({ ...base, state: "off" });
        continue;
      }
      try {
        const plan = this.planMcp(target, await readText(target.file), servers, state.mcp.written[target.file] ?? {}, false);
        const pending = Object.keys(plan.set).length > 0 || plan.remove.length > 0;
        statuses.push({ ...base, state: plan.conflicts.length > 0 || pending ? "conflict" : "synced", conflicts: [...plan.conflicts, ...(pending ? [...plan.add, ...plan.update, ...plan.remove] : [])] });
      } catch (error) {
        statuses.push({ ...base, state: "error", problem: (error as Error).message });
      }
    }
    return { servers, agents: statuses };
  }
}
