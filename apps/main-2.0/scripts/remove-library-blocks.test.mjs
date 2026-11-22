import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const { removeLibraryBlocks, removeRetiredLibraryParts } = require("../bin/remove-library-blocks.cjs");
const temporaryDirectories = new Set();
after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

const BEGIN = "<!-- agentrecall:library begin -->";
const END = "<!-- agentrecall:library end -->";

test("takes back only the Library blocks AgentRecall wrote and keeps edited ones", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-library-uninstall-"));
  temporaryDirectories.add(homeDir);
  const claude = path.join(homeDir, ".claude", "CLAUDE.md");
  const codex = path.join(homeDir, ".codex", "AGENTS.md");
  const gone = path.join(homeDir, ".gemini", "GEMINI.md");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(claude, `# Mine\r\n\r\n${BEGIN}\r\nrule\r\n${END}\r\n`);
  fs.writeFileSync(codex, `${BEGIN}\nedited by hand\n${END}\n`);
  const root = path.join(homeDir, ".agent-recall-v2", "library");
  fs.mkdirSync(root, { recursive: true });
  const state = { schemaVersion: 1, enabled: ["claude-code", "codex", "gemini"], written: { [claude]: "rule", [codex]: "rule", [gone]: "rule" }, backedUp: [] };
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));

  const result = removeLibraryBlocks({ homeDir });

  assert.equal(result.status, "removed");
  assert.equal(fs.readFileSync(claude, "utf8"), "# Mine\n");
  assert.equal(fs.readFileSync(codex, "utf8"), `${BEGIN}\nedited by hand\n${END}\n`);
  assert.match(result.detail, /AGENTS\.md/);
  const next = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.deepEqual(next.enabled, []);
  assert.deepEqual(Object.keys(next.written), [codex]);
});

test("does nothing without a Library and refuses a state it does not understand", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-library-uninstall-"));
  temporaryDirectories.add(homeDir);
  assert.equal(removeLibraryBlocks({ homeDir }).status, "unchanged");
  const root = path.join(homeDir, ".agent-recall-v2", "library");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ schemaVersion: 9 }));
  assert.equal(removeLibraryBlocks({ homeDir }).status, "error");
});

test("takes back the MCP servers AgentRecall wrote and keeps edited ones and the user's own", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-library-mcp-uninstall-"));
  temporaryDirectories.add(homeDir);
  const claude = path.join(homeDir, ".claude.json");
  const codex = path.join(homeDir, ".codex", "config.toml");
  const opencode = path.join(homeDir, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.mkdirSync(path.dirname(opencode), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "m" }, docs: { type: "stdio", command: "d" }, web: { type: "http", url: "https://edited" } } }));
  const docsBlock = '[mcp_servers.docs]\ncommand = "d"';
  fs.writeFileSync(codex, `# keep\nmodel = "x"\n\n${docsBlock}\n\n[mcp_servers.mine]\ncommand = "m"\n`);
  fs.writeFileSync(opencode, JSON.stringify({ mcp: { docs: { type: "local", command: ["d"], enabled: true } } }));
  const root = path.join(homeDir, ".agent-recall-v2", "library");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    schemaVersion: 1, enabled: [], written: {}, backedUp: [],
    mcp: {
      enabled: ["claude-code", "codex", "opencode"],
      written: {
        [claude]: { docs: { type: "stdio", command: "d" }, web: { type: "http", url: "https://original" } },
        [codex]: { docs: docsBlock },
        [opencode]: { docs: { type: "local", command: ["d"], enabled: true } },
      },
    },
  }));

  const result = removeLibraryBlocks({ homeDir });
  assert.equal(result.status, "removed");
  assert.match(result.detail, /web/);
  assert.deepEqual(JSON.parse(fs.readFileSync(claude, "utf8")), { theme: "dark", mcpServers: { mine: { command: "m" }, web: { type: "http", url: "https://edited" } } });
  assert.equal(fs.readFileSync(codex, "utf8"), '# keep\nmodel = "x"\n\n[mcp_servers.mine]\ncommand = "m"\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(opencode, "utf8")), { mcp: {} });
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.deepEqual(state.mcp, { enabled: [], written: { [claude]: { web: { type: "http", url: "https://original" } } } });
});

test("deletes the command and subagent files AgentRecall wrote and keeps edited ones", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-library-uninstall-"));
  temporaryDirectories.add(homeDir);
  const ours = path.join(homeDir, ".claude", "commands", "review.md");
  const edited = path.join(homeDir, ".claude", "agents", "reviewer.md");
  fs.mkdirSync(path.dirname(ours), { recursive: true });
  fs.mkdirSync(path.dirname(edited), { recursive: true });
  fs.writeFileSync(ours, "written\n");
  fs.writeFileSync(edited, "changed by hand\n");
  const root = path.join(homeDir, ".agent-recall-v2", "library");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    schemaVersion: 1, enabled: [], written: {},
    files: { commands: { enabled: ["claude-code"], written: { [ours]: "written\n" } }, subagents: { enabled: ["claude-code"], written: { [edited]: "written\n" } } },
  }));
  const result = removeLibraryBlocks({ homeDir });
  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(ours), false);
  assert.equal(fs.readFileSync(edited, "utf8"), "changed by hand\n");
  assert.match(result.detail, /reviewer\.md/);
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.deepEqual(state.files.commands, { enabled: [], written: {} });
});

test("at startup takes back only the retired MCP, command and subagent parts and lists what it kept", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-library-retired-"));
  temporaryDirectories.add(homeDir);
  const claude = path.join(homeDir, ".claude", "CLAUDE.md");
  const command = path.join(homeDir, ".claude", "commands", "review.md");
  const edited = path.join(homeDir, ".claude", "agents", "reviewer.md");
  const gemini = path.join(homeDir, ".gemini", "settings.json");
  for (const file of [claude, command, edited, gemini]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(claude, `${BEGIN}\nrule\n${END}\n`);
  fs.writeFileSync(command, "written\n");
  fs.writeFileSync(edited, "changed by hand\n");
  fs.writeFileSync(gemini, JSON.stringify({ theme: "dark", mcpServers: { docs: { command: "docs-mcp" } } }));
  const root = path.join(homeDir, ".agent-recall-v2", "library");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    schemaVersion: 1, enabled: ["claude-code"], written: { [claude]: "rule" }, backedUp: [],
    mcp: { enabled: ["gemini"], written: { [gemini]: { docs: { command: "docs-mcp" } } } },
    files: { commands: { enabled: ["claude-code"], written: { [command]: "written\n" } }, subagents: { enabled: ["claude-code"], written: { [edited]: "written\n" } } },
  }));

  const result = removeRetiredLibraryParts({ homeDir });

  assert.equal(result.status, "removed");
  assert.equal(fs.readFileSync(claude, "utf8"), `${BEGIN}\nrule\n${END}\n`);
  assert.equal(fs.existsSync(command), false);
  assert.equal(fs.readFileSync(edited, "utf8"), "changed by hand\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(gemini, "utf8")), { theme: "dark", mcpServers: {} });
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.deepEqual(state.enabled, ["claude-code"]);
  assert.deepEqual(state.written, { [claude]: "rule" });
  assert.equal("mcp" in state, false);
  assert.equal("files" in state, false);
  assert.deepEqual(state.retiredKept, [edited]);
  assert.deepEqual(removeRetiredLibraryParts({ homeDir }), { status: "unchanged", detail: "" });
});
