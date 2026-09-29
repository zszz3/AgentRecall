import type { IpcRenderer } from "electron";
import { TEAM_WORKSPACE_IPC, type TeamReply, type TeamRequest } from "../shared/ipc/team-workspace";

export function createTeamWorkspaceApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    request: async (request: TeamRequest): Promise<TeamReply> => {
      try { return await ipc.invoke(TEAM_WORKSPACE_IPC.channel, request) as TeamReply; }
      catch { return { ok: false, error: { code: "TEAM_REQUEST_FAILED", message: "团队请求未完成，请检查输入或刷新后重试。" } }; }
    },
  };
}
export type TeamWorkspaceApi = ReturnType<typeof createTeamWorkspaceApi>;
