import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LibraryAgentId } from "../../core/library-agent-ids";
import { resolveLibraryAgents, type LibraryAgent } from "../../core/library-agents";
import type { LibraryAgentState, LibraryAgentStatus, LibraryImportCandidate, LibraryPreview, PersonalLibrarySnapshot } from "../../shared/ipc/personal-library";
import { hasMagpieBlock, ownedBlock, personalParagraphs, withOwnedBlock, withoutParagraphs } from "../../core/library-instructions";

interface LibraryState {
  schemaVersion: 1;
  enabled: LibraryAgentId[];
  /** Library block body last written to each file, keyed by absolute path. */
  written: Record<string, string>;
  /** Files already backed up before AgentRecall first changed them. */
  backedUp: string[];
  /** Written by the startup cleanup of retired Library parts (bin/remove-library-blocks.cjs). */
  retiredKept?: string[];
}

const KEEP_BACKUPS = 30;
const emptyState = (): LibraryState => ({ schemaVersion: 1, enabled: [], written: {}, backedUp: [] });

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

  dismissRetiredKept(): Promise<PersonalLibrarySnapshot> {
    return this.serial(async () => {
      const state = await this.readState();
      delete state.retiredKept;
      await this.saveState(state);
      return this.describe(await this.readInstructions(), state);
    });
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
      const { agents, file } = await this.target(id);
      const current = await readText(file);
      const others = this.sharers(agents, state, file).filter((other) => other !== id);
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
    return { ...emptyState(), ...parsed, schemaVersion: 1 };
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
        magpie: agent.instructions !== null && hasMagpieBlock(await readText(agent.instructions) ?? ""),
      });
    }
    return { instructions, agents: statuses, retiredKept: state.retiredKept ?? [] };
  }

  private async stateOf(agent: LibraryAgent, agents: readonly LibraryAgent[], state: LibraryState, enabled: boolean): Promise<LibraryAgentState> {
    const file = agent.instructions;
    if (!file) return "unsupported";
    const text = await readText(file);
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
}
