import path from "node:path";

export interface AutomationPaths {
  fileStoragePath: string;
  channelsPath: string;
  discoveryPath: string;
}

export function resolveAutomationPaths(
  userDataPath: string,
  pathApi: Pick<typeof path, "join"> = path,
): AutomationPaths {
  return {
    fileStoragePath: pathApi.join(userDataPath, "automation", "state.json"),
    channelsPath: pathApi.join(userDataPath, "runtime-channels.json"),
    discoveryPath: pathApi.join(userDataPath, "automation-mcp-bridge.json"),
  };
}
