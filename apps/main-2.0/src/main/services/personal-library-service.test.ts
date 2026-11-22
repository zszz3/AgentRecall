import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_BEGIN, LIBRARY_END } from "../../core/library-instructions";
import { PersonalLibraryService } from "./personal-library-service";

let home = "";
let root = "";
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "library-home-"));
  root = path.join(home, "app-data", "library");
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");
const codexFile = () => path.join(home, ".codex", "AGENTS.md");
async function put(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
const read = (file: string) => fs.readFile(file, "utf8");
const backups = async () => (await fs.readdir(path.join(root, "backups")).catch(() => [])).length;
function library(env: Record<string, string> = {}) {
  return new PersonalLibraryService({ root, home, env });
}
const agent = (snapshot: Awaited<ReturnType<PersonalLibraryService["snapshot"]>>, id: string) => snapshot.agents.find((item) => item.id === id)!;

describe("PersonalLibraryService instructions", () => {
  it("writes the Library block into the agents turned on and takes only that block back", async () => {
    await put(claudeFile(), "# Mine\n\nKeep this.\n");
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    const service = library();
    await service.saveInstructions("Answer in Chinese.");
    expect(await read(claudeFile())).toBe("# Mine\n\nKeep this.\n");

    expect((await service.preview("claude-code", true)).after).toBe(`# Mine\n\nKeep this.\n\n${LIBRARY_BEGIN}\nAnswer in Chinese.\n${LIBRARY_END}\n`);
    let snapshot = await service.setAgentEnabled("claude-code", true);
    snapshot = await service.setAgentEnabled("codex", true);
    expect(await read(claudeFile())).toBe(`# Mine\n\nKeep this.\n\n${LIBRARY_BEGIN}\nAnswer in Chinese.\n${LIBRARY_END}\n`);
    expect(await read(codexFile())).toBe(`${LIBRARY_BEGIN}\nAnswer in Chinese.\n${LIBRARY_END}\n`);
    expect(agent(snapshot, "claude-code")).toMatchObject({ enabled: true, state: "synced" });
    expect(agent(snapshot, "gemini")).toMatchObject({ installed: false, enabled: false, state: "off" });
    expect(agent(snapshot, "cursor")).toMatchObject({ state: "unsupported" });
    expect(await backups()).toBe(1);

    await service.saveInstructions("Use English commit messages.");
    expect(await read(codexFile())).toContain("Use English commit messages.");
    expect(await read(path.join(root, "instructions.md"))).toBe("Use English commit messages.\n");

    snapshot = await service.setAgentEnabled("claude-code", false);
    expect(await read(claudeFile())).toBe("# Mine\n\nKeep this.\n");
    expect(agent(snapshot, "claude-code")).toMatchObject({ enabled: false, state: "off" });

    const reopened = await library().snapshot();
    expect(reopened.instructions).toBe("Use English commit messages.");
    expect(agent(reopened, "codex")).toMatchObject({ enabled: true, state: "synced" });
  });

  it("stops at a block edited outside AgentRecall until the user picks which version wins", async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    const service = library();
    await service.saveInstructions("v1");
    await service.setAgentEnabled("claude-code", true);
    await service.setAgentEnabled("codex", true);
    const edited = `${LIBRARY_BEGIN}\nv1 edited by hand\n${LIBRARY_END}\n`;
    await fs.writeFile(claudeFile(), edited);

    let snapshot = await service.saveInstructions("v2");
    expect(await read(claudeFile())).toBe(edited);
    expect(await read(codexFile())).toContain("v2");
    expect(agent(snapshot, "claude-code")).toMatchObject({ state: "conflict" });
    await expect(service.setAgentEnabled("claude-code", false)).rejects.toThrow(/changed outside AgentRecall/);

    snapshot = await service.resolveConflict("claude-code", "use-file");
    expect(snapshot.instructions).toBe("v1 edited by hand");
    expect(await read(codexFile())).toContain("v1 edited by hand");
    expect(agent(snapshot, "claude-code")).toMatchObject({ state: "synced" });

    await fs.writeFile(claudeFile(), `${LIBRARY_BEGIN}\nagain\n${LIBRARY_END}\n`);
    const before = await backups();
    snapshot = await service.resolveConflict("claude-code", "overwrite");
    expect(await read(claudeFile())).toContain("v1 edited by hand");
    expect(await backups()).toBe(before + 1);
    expect(agent(snapshot, "claude-code")).toMatchObject({ state: "synced" });
  });

  it("treats a block it never wrote as a conflict and leaves files managed by magpie alone", async () => {
    await put(claudeFile(), `${LIBRARY_BEGIN}\nfrom another install\n${LIBRARY_END}\n`);
    await put(codexFile(), "<!-- magpie:begin · written by magpie from its Library -->\nrule\n<!-- magpie:end -->\n");
    const service = library();
    await service.saveInstructions("mine");
    const snapshot = await service.snapshot();
    expect(agent(snapshot, "claude-code")).toMatchObject({ state: "conflict" });
    expect(agent(snapshot, "codex")).toMatchObject({ state: "magpie" });
    await expect(service.setAgentEnabled("claude-code", true)).rejects.toThrow(/changed outside AgentRecall/);
    await expect(service.setAgentEnabled("codex", true)).rejects.toThrow(/magpie/);
    expect(await read(codexFile())).toContain("magpie:begin");
  });

  it("writes nothing when the Library itself cannot be read", async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const service = library();
    await service.saveInstructions("keep me");
    await service.setAgentEnabled("claude-code", true);
    await fs.rm(path.join(root, "instructions.md"));
    await fs.mkdir(path.join(root, "instructions.md"));
    await expect(library().snapshot()).rejects.toThrow(/Library instructions/);
    await expect(library().setAgentEnabled("claude-code", false)).rejects.toThrow(/Library instructions/);
    expect(await read(claudeFile())).toContain("keep me");
  });

  it("keeps a file two agents read written while either of them is on", async () => {
    const shared = path.join(home, "shared-agent");
    await fs.mkdir(path.join(home, ".stepcode"), { recursive: true });
    const service = library({ PI_CODING_AGENT_DIR: shared, STEP_CODING_AGENT_DIR: shared });
    await put(path.join(shared, "AGENTS.md"), "own\n");
    await service.saveInstructions("shared rule");
    await service.setAgentEnabled("pi", true);
    await service.setAgentEnabled("stepcode", true);
    await service.setAgentEnabled("pi", false);
    expect(await read(path.join(shared, "AGENTS.md"))).toContain("shared rule");
    await service.setAgentEnabled("stepcode", false);
    expect(await read(path.join(shared, "AGENTS.md"))).toBe("own\n");
  });

  it("imports the agents' own paragraphs once and moves them out of the files only when asked", async () => {
    await put(claudeFile(), "Answer in Chinese.\n\nRun tests first.\n");
    await put(codexFile(), "Answer in Chinese.\n\n<!-- agentrecall:team begin -->\nteam\n<!-- agentrecall:team end -->\n\nPrefer rg.\n");
    const service = library();
    await service.saveInstructions("Prefer rg.");
    const candidates = await service.importCandidates();
    expect(candidates).toEqual([
      { text: "Answer in Chinese.", agents: ["claude-code", "codex"] },
      { text: "Run tests first.", agents: ["claude-code"] },
    ]);

    const snapshot = await service.importParagraphs(["Answer in Chinese."], true);
    expect(snapshot.instructions).toBe("Prefer rg.\n\nAnswer in Chinese.");
    expect(await read(claudeFile())).toBe("Run tests first.\n");
    expect(await read(codexFile())).toBe("<!-- agentrecall:team begin -->\nteam\n<!-- agentrecall:team end -->\n\nPrefer rg.\n");
    expect(await backups()).toBe(2);
    expect(agent(snapshot, "claude-code")).toMatchObject({ enabled: false });
  });
});
