import { describe, expect, it } from "vitest";
import { buildManagedMcpBlock, diagnoseManagedMcpsForAgent, mergeManagedMcpBlock, removeManagedMcpBlock } from "./mcp-config";

describe("managed MCP config", () => {
  const block = buildManagedMcpBlock({ serverName: "agent_recall_agent_a_filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\repo"], env: {}, agentId: "agent-a", catalogId: "filesystem" });

  it("preserves unrelated config when installing", () => {
    const result = mergeManagedMcpBlock('[model]\nname = "gpt"\n', block);
    expect(result).toContain('[model]\nname = "gpt"');
    expect(result).toContain("BEGIN AGENT_RECALL MCP");
  });

  it("updates an existing managed block", () => {
    const installed = mergeManagedMcpBlock("", block);
    const updated = mergeManagedMcpBlock(installed, block.replace("C:\\\\repo", "C:\\\\other"));
    expect(updated.match(/BEGIN AGENT_RECALL MCP/g)).toHaveLength(1);
    expect(updated).toContain("other");
  });

  it("rejects unmanaged name collisions", () => {
    expect(() => mergeManagedMcpBlock('[mcp_servers.agent_recall_agent_a_filesystem]\ncommand = "other"\n', block)).toThrow(/already exists/);
  });

  it("removes only the selected managed block", () => {
    const installed = mergeManagedMcpBlock('[mcp_servers.keep]\ncommand = "keep"\n', block);
    const removed = removeManagedMcpBlock(installed, "agent_recall_agent_a_filesystem");
    expect(removed).toContain("mcp_servers.keep");
    expect(removed).not.toContain("agent_a_filesystem");
  });

  it("diagnoses a configured server as healthy", () => {
    const result = diagnoseManagedMcpsForAgent(mergeManagedMcpBlock("", block), "agent-a");
    expect(result).toEqual([expect.objectContaining({ catalogId: "filesystem", status: "healthy", toolCount: 2 })]);
  });

  it("reports a missing required path as needing setup", () => {
    const withoutPath = buildManagedMcpBlock({ serverName: "agent_recall_agent_a_filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: {}, agentId: "agent-a", catalogId: "filesystem" });
    const result = diagnoseManagedMcpsForAgent(withoutPath, "agent-a");
    expect(result[0]).toEqual(expect.objectContaining({ status: "needs_setup", missingRequirements: ["Allowed directory"] }));
  });

  it("reports a missing required token as needing setup", () => {
    const withoutToken = buildManagedMcpBlock({ serverName: "agent_recall_agent_a_github", command: "docker", args: ["run"], env: {}, agentId: "agent-a", catalogId: "github" });
    const result = diagnoseManagedMcpsForAgent(withoutToken, "agent-a");
    expect(result[0]).toEqual(expect.objectContaining({ status: "needs_setup", missingRequirements: ["GitHub PAT"] }));
  });

  it("never adopts or removes Multi Agent Chat managed blocks", () => {
    const legacy = "# BEGIN MULTI_AGENT_CHAT MCP multi_agent_chat_agent_a_filesystem agent=agent-a catalog=filesystem\n"
      + "[mcp_servers.multi_agent_chat_agent_a_filesystem]\ncommand = 'legacy'\n"
      + "# END MULTI_AGENT_CHAT MCP multi_agent_chat_agent_a_filesystem\n";
    const installed = mergeManagedMcpBlock(legacy, block);
    const removed = removeManagedMcpBlock(installed, "agent_recall_agent_a_filesystem");

    expect(installed).toContain("BEGIN MULTI_AGENT_CHAT MCP");
    expect(installed).toContain("BEGIN AGENT_RECALL MCP");
    expect(removed).toContain("BEGIN MULTI_AGENT_CHAT MCP");
    expect(removed).not.toContain("BEGIN AGENT_RECALL MCP");
  });
});
