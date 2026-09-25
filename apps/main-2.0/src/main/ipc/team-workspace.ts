import type { TeamWorkspaceService } from "../services/team-workspace-service";
import { TEAM_WORKSPACE_IPC } from "../../shared/ipc/team-workspace";
import { registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export function registerTeamWorkspaceIpc(ipc: IpcMainRegistrar, service: TeamWorkspaceService): () => void {
  return registerIpcHandler(ipc, TEAM_WORKSPACE_IPC, async (event, request) => {
    const owner = event.sender.id;
    const cancel = () => service.cancel(owner);
    event.sender.once("destroyed", cancel);
    try { return await service.request(owner, request); }
    finally { event.sender.removeListener("destroyed", cancel); }
  });
}
