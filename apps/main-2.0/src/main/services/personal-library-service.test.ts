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

describe("PersonalLibraryService MCP servers", () => {
  const claudeJson = () => path.join(home, ".claude.json");
  const codexToml = () => path.join(home, ".codex", "config.toml");
  const mcpAgent = (snapshot: Awaited<ReturnType<PersonalLibraryService["snapshot"]>>, id: string) => snapshot.mcp.agents.find((item) => item.id === id)!;
  const docs = { command: "npx", args: ["-y", "docs-mcp"] };

  it("adds, updates and removes only the servers it wrote and leaves the rest of the file", async () => {
    await put(claudeJson(), JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "m" } } }));
    const service = library();
    await service.saveMcpServers({ docs });
    expect(await service.previewMcp("claude-code", true)).toEqual({ file: claudeJson(), add: ["docs"], update: [], remove: [], conflicts: [] });

    let snapshot = await service.setMcpAgentEnabled("claude-code", true);
    expect(mcpAgent(snapshot, "claude-code")).toMatchObject({ enabled: true, state: "synced", conflicts: [] });
    expect(JSON.parse(await read(claudeJson()))).toEqual({ theme: "dark", mcpServers: { mine: { command: "m" }, docs: { type: "stdio", ...docs } } });
    expect(await backups()).toBe(1);

    await service.saveMcpServers({ docs: { command: "docs-mcp" }, web: { url: "https://mcp.example.com/mcp" } });
    expect(JSON.parse(await read(claudeJson())).mcpServers).toEqual({
      mine: { command: "m" }, docs: { type: "stdio", command: "docs-mcp" }, web: { type: "http", url: "https://mcp.example.com/mcp" },
    });
    await service.saveMcpServers({ web: { url: "https://mcp.example.com/mcp" } });
    expect(Object.keys(JSON.parse(await read(claudeJson())).mcpServers)).toEqual(["mine", "web"]);

    snapshot = await service.setMcpAgentEnabled("claude-code", false);
    expect(JSON.parse(await read(claudeJson()))).toEqual({ theme: "dark", mcpServers: { mine: { command: "m" } } });
    expect(mcpAgent(snapshot, "claude-code")).toMatchObject({ enabled: false, state: "off" });
    expect(mcpAgent(snapshot, "pi")).toMatchObject({ state: "unsupported", file: null });
  });

  it("leaves a server with the same name or one edited outside AgentRecall until the user overwrites it", async () => {
    await put(codexToml(), '# keep\n[mcp_servers.docs]\ncommand = "theirs"\n');
    const service = library();
    await service.saveMcpServers({ docs, web: { url: "https://mcp.example.com/mcp" } });
    let snapshot = await service.setMcpAgentEnabled("codex", true);
    expect(mcpAgent(snapshot, "codex")).toMatchObject({ state: "conflict", conflicts: ["docs"] });
    let text = await read(codexToml());
    expect(text).toContain('[mcp_servers.docs]\ncommand = "theirs"');
    expect(text).toContain("[mcp_servers.web]");

    snapshot = await service.overwriteMcp("codex");
    text = await read(codexToml());
    expect(text.startsWith("# keep\n")).toBe(true);
    expect(text).not.toContain("theirs");
    expect(mcpAgent(snapshot, "codex")).toMatchObject({ state: "synced", conflicts: [] });

    await fs.writeFile(codexToml(), text.replace('url = "https://mcp.example.com/mcp"', 'url = "https://changed.example.com/mcp"'));
    snapshot = await service.saveMcpServers({ docs, web: { url: "https://mcp.example.com/v2" } });
    expect(mcpAgent(snapshot, "codex")).toMatchObject({ state: "conflict", conflicts: ["web"] });
    expect(await read(codexToml())).toContain("https://changed.example.com/mcp");

    snapshot = await service.setMcpAgentEnabled("codex", false);
    text = await read(codexToml());
    expect(text).toContain("https://changed.example.com/mcp");
    expect(text).not.toContain("[mcp_servers.docs]");
    expect(mcpAgent(snapshot, "codex")).toMatchObject({ state: "off", conflicts: [] });
  });

  it("imports servers other agents use once each and refuses names it cannot write", async () => {
    await put(claudeJson(), JSON.stringify({ mcpServers: { docs: { type: "stdio", ...docs }, "agent-recall": { command: "x" }, oauth: { type: "http", url: "https://a", oauth: {} } } }));
    await put(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { docs, other: { url: "https://b.example.com" } } }));
    const service = library();
    expect(await service.mcpImportCandidates()).toEqual([
      { name: "docs", server: docs, agents: ["claude-code", "cursor"] },
      { name: "other", server: { url: "https://b.example.com" }, agents: ["cursor"] },
    ]);
    const snapshot = await service.importMcpServers([{ name: "docs", server: docs }]);
    expect(snapshot.mcp.servers).toEqual({ docs });
    expect((await service.mcpImportCandidates()).map((item) => item.name)).toEqual(["other"]);
    await expect(service.saveMcpServers({ "agent-recall": docs })).rejects.toThrow(/agent-recall/);
    await expect(service.saveMcpServers({ "bad name": docs })).rejects.toThrow(/bad name/);
    await expect(service.importMcpServers([{ name: "docs", server: { command: "other" } }])).rejects.toThrow(/already has a server named "docs"/);
  });
});

describe("PersonalLibraryService slash commands and subagents", () => {
  const review = { description: "Review a change", body: "Review $ARGUMENTS." };
  const claudeCommand = () => path.join(home, ".claude", "commands", "review.md");
  const geminiCommand = () => path.join(home, ".gemini", "commands", "review.toml");
  const status = (snapshot: Awaited<ReturnType<PersonalLibraryService["snapshot"]>>, kind: "commands" | "subagents", id: string) =>
    snapshot[kind].agents.find((item) => item.id === id)!;

  it("writes one file per command in each agent's format and deletes only the files it wrote", async () => {
    await put(path.join(home, ".claude", "commands", "mine.md"), "My own command.\n");
    const service = library();
    await service.saveFiles("commands", { review });
    expect(await service.previewFiles("commands", "gemini", true)).toEqual({ file: path.join(home, ".gemini", "commands"), add: ["review"], update: [], remove: [], conflicts: [] });
    await service.setFilesAgentEnabled("commands", "claude-code", true);
    let snapshot = await service.setFilesAgentEnabled("commands", "gemini", true);
    expect(await read(claudeCommand())).toBe('---\ndescription: "Review a change"\n---\n\nReview $ARGUMENTS.\n');
    expect(await read(geminiCommand())).toContain('prompt = "Review {{args}}."');
    expect(status(snapshot, "commands", "gemini")).toMatchObject({ enabled: true, state: "synced" });
    expect(status(snapshot, "commands", "codex")).toMatchObject({ state: "unsupported" });

    await fs.writeFile(geminiCommand(), 'description = "mine now"\nprompt = "x"\n');
    snapshot = await service.saveFiles("commands", { review: { ...review, body: "Review $ARGUMENTS carefully." } });
    expect(await read(claudeCommand())).toContain("carefully");
    expect(status(snapshot, "commands", "gemini")).toMatchObject({ state: "conflict", conflicts: ["review"] });
    expect(await read(geminiCommand())).toContain("mine now");

    snapshot = await service.saveFiles("commands", {});
    await expect(fs.stat(claudeCommand())).rejects.toThrow();
    expect(await read(path.join(home, ".claude", "commands", "mine.md"))).toBe("My own command.\n");
    snapshot = await service.setFilesAgentEnabled("commands", "gemini", false);
    expect(await read(geminiCommand())).toContain("mine now");
    expect(status(snapshot, "commands", "gemini")).toMatchObject({ state: "off" });
  });

  it("leaves a same-named file it did not write until the user overwrites it, then imports others once", async () => {
    const agentFile = path.join(home, ".claude", "agents", "reviewer.md");
    await put(agentFile, "---\nname: reviewer\ndescription: theirs\n---\n\nTheir reviewer.\n");
    await put(path.join(home, ".cursor", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: theirs\n---\n\nTheir reviewer.\n");
    const service = library();
    expect(await service.fileImportCandidates("subagents")).toEqual([
      { name: "reviewer", item: { description: "theirs", body: "Their reviewer." }, agents: ["claude-code", "cursor"] },
    ]);
    await service.saveFiles("subagents", { reviewer: review });
    let snapshot = await service.setFilesAgentEnabled("subagents", "claude-code", true);
    expect(status(snapshot, "subagents", "claude-code")).toMatchObject({ state: "conflict", conflicts: ["reviewer"] });
    expect(await read(agentFile)).toContain("Their reviewer.");
    snapshot = await service.overwriteFiles("subagents", "claude-code");
    expect(await read(agentFile)).toContain('name: "reviewer"');
    expect(status(snapshot, "subagents", "claude-code")).toMatchObject({ state: "synced" });
    expect(await backups()).toBe(1);
    await expect(service.importFiles("subagents", [{ name: "reviewer", item: { description: "x", body: "y" } }])).rejects.toThrow(/already has/);
    await expect(service.saveFiles("commands", { "../evil": review })).rejects.toThrow(/cannot be used/);
  });
});
