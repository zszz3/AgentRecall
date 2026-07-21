import path from "node:path";

export interface AutomationPaths {
  databasePath: string;
  channelsPath: string;
  discoveryPath: string;
  bundledSkillsPath: string;
}

export function resolveAutomationPaths(
  userDataPath: string,
  pathApi: Pick<typeof path, "join"> = path,
): AutomationPaths {
  return {
    databasePath: pathApi.join(userDataPath, "automation.db"),
    channelsPath: pathApi.join(userDataPath, "runtime-channels.json"),
    discoveryPath: pathApi.join(userDataPath, "automation-mcp-bridge.json"),
    bundledSkillsPath: pathApi.join(userDataPath, "automation-skills"),
  };
}
