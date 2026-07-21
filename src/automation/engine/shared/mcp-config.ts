export interface McpSetupStatus { serverPath: string; bridgePath: string; configPath: string; serverBuilt: boolean; bridgeRunning: boolean; workflowCreateAvailable: boolean; }
export interface ManagedMcpBlockInput { serverName: string; command: string; args: string[]; env: Record<string,string>; agentId: string; catalogId: string; }
export interface McpCatalogItem { id: string; name: string; description: string; category: "bundled"|"official"; command: string; defaultArgs: string[]; requiresPath?: boolean; requiresToken?: boolean; }
export const MCP_CATALOG: McpCatalogItem[] = [
 { id:"workflow", name:"AgentRecall Workflow", description:"Create and manage AgentRecall workflows with workflow_create.", category:"bundled", command:"node", defaultArgs:[] },
 { id:"filesystem", name:"Filesystem", description:"Read and write files under explicitly allowed directories.", category:"official", command:"npx", defaultArgs:["-y","@modelcontextprotocol/server-filesystem"], requiresPath:true },
 { id:"github", name:"GitHub", description:"Work with repositories, issues and pull requests using GitHub's MCP server.", category:"official", command:"docker", defaultArgs:["run","-i","--rm","-e","GITHUB_PERSONAL_ACCESS_TOKEN","ghcr.io/github/github-mcp-server"], requiresToken:true },
 { id:"sequential-thinking", name:"Sequential Thinking", description:"Structured step-by-step problem solving tools.", category:"official", command:"npx", defaultArgs:["-y","@modelcontextprotocol/server-sequential-thinking"] },
];
export function mcpServerNameForAgent(agentId:string,catalogId="workflow"):string { const clean=(v:string)=>v.toLowerCase().replace(/[^a-z0-9_]+/g,"_").replace(/^_+|_+$/g,"")||"item"; return `agent_recall_${clean(agentId)}_${clean(catalogId)}`; }
const q=(v:string)=>`'${v.replace(/\\/g,"\\\\").replace(/'/g,"\\'")}'`;
export function buildManagedMcpBlock(input:ManagedMcpBlockInput):string { const marker=`${input.serverName} agent=${input.agentId} catalog=${input.catalogId}`; const envEntries=Object.entries(input.env).map(([k,v])=>`${k} = ${q(v)}`).join(", "); return `# BEGIN AGENT_RECALL MCP ${marker}\n[mcp_servers.${input.serverName}]\ntype = "stdio"\ncommand = ${q(input.command)}\nargs = [${input.args.map(q).join(", ")}]${envEntries?`\nenv = { ${envEntries} }`:""}\n# END AGENT_RECALL MCP ${input.serverName}`; }
function range(content:string,name:string):[number,number]|undefined { const begin=`# BEGIN AGENT_RECALL MCP ${name} `; const start=content.indexOf(begin); if(start<0)return; const endMarker=`# END AGENT_RECALL MCP ${name}`; const end=content.indexOf(endMarker,start); if(end<0)throw new Error(`Managed MCP block ${name} is incomplete.`); return [start,end+endMarker.length]; }
export function mergeManagedMcpBlock(content:string,block:string):string { const match=block.match(/^# BEGIN AGENT_RECALL MCP ([^ ]+) /); if(!match)throw new Error("Invalid managed MCP block."); const name=match[1]!; const existing=range(content,name); if(existing)return `${content.slice(0,existing[0])}${block}${content.slice(existing[1])}`; if(content.includes(`[mcp_servers.${name}]`))throw new Error(`MCP server ${name} already exists and is not managed by AgentRecall.`); return `${content.trimEnd()}${content.trim()?"\n\n":""}${block}\n`; }
export function removeManagedMcpBlock(content:string,name:string):string { const existing=range(content,name); if(!existing)return content; return `${content.slice(0,existing[0])}${content.slice(existing[1])}`.replace(/\n{3,}/g,"\n\n").trimEnd()+"\n"; }
export function buildCodexMcpConfigSnippet(input:{serverPath:string;bridgePath:string;configuredAgentId:string;serverName:string}):string { return buildManagedMcpBlock({serverName:input.serverName,command:"node",args:[input.serverPath],env:{AGENT_RECALL_WORKFLOW_MCP_BRIDGE:input.bridgePath,AGENT_RECALL_CONFIGURED_AGENT_ID:input.configuredAgentId},agentId:input.configuredAgentId,catalogId:"workflow"}); }

export interface McpInstallRequest { agentId:string; catalogId:string; allowedPath?:string; token?:string; }
export interface McpInstallResult { configPath:string; backupPath?:string; serverName:string; installed:boolean; }
export interface McpInstalledEntry { serverName:string; agentId:string; catalogId:string; }
export function listManagedMcpEntries(content:string):McpInstalledEntry[] { return [...content.matchAll(/^# BEGIN AGENT_RECALL MCP ([^ ]+) agent=([^ ]+) catalog=([^\r\n]+)/gm)].map((m)=>({serverName:m[1]!,agentId:m[2]!,catalogId:m[3]!})); }

export type McpDiagnosticStatus = "healthy" | "needs_setup" | "error" | "unknown";
export interface McpAgentDiagnostic extends McpInstalledEntry {
  name: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  status: McpDiagnosticStatus;
  missingRequirements: string[];
  toolCount: number;
}

const MCP_TOOL_COUNTS: Record<string, number> = {
  workflow: 3,
  filesystem: 2,
  github: 12,
  "sequential-thinking": 1,
};

function managedMcpBlock(content: string, serverName: string): string | undefined {
  const bounds = range(content, serverName);
  return bounds ? content.slice(bounds[0], bounds[1]) : undefined;
}

function quotedValues(value: string): string[] {
  return [...value.matchAll(/'((?:\\.|[^'])*)'/g)].map((match) => match[1]!.replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
}

export function diagnoseManagedMcpsForAgent(content: string, agentId: string): McpAgentDiagnostic[] {
  return listManagedMcpEntries(content)
    .filter((entry) => entry.agentId === agentId)
    .map((entry) => {
      const catalog = MCP_CATALOG.find((item) => item.id === entry.catalogId);
      const block = managedMcpBlock(content, entry.serverName);
      const command = block?.match(/^command = '([^']*)'$/m)?.[1] ?? "";
      const args = quotedValues(block?.match(/^args = \[(.*)\]$/m)?.[1] ?? "");
      const envKeys = [...(block?.match(/^env = \{(.*)\}$/m)?.[1] ?? "").matchAll(/([A-Z0-9_]+)\s*=/g)].map((match) => match[1]!);
      const missingRequirements = [
        ...(catalog?.requiresPath && args.length <= catalog.defaultArgs.length ? ["Allowed directory"] : []),
        ...(catalog?.requiresToken && !envKeys.includes("GITHUB_PERSONAL_ACCESS_TOKEN") ? ["GitHub PAT"] : []),
      ];
      return {
        ...entry,
        name: catalog?.name ?? entry.catalogId,
        description: catalog?.description ?? "This managed MCP is no longer in the local catalog.",
        command,
        args,
        envKeys,
        status: !catalog || !block || !command ? "error" : missingRequirements.length > 0 ? "needs_setup" : "healthy",
        missingRequirements,
        toolCount: MCP_TOOL_COUNTS[entry.catalogId] ?? 0,
      };
    });
}
