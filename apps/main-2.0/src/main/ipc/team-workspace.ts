import type { WebContents } from "electron";
import type { TeamWorkspaceService } from "../services/team-workspace-service";
import { TEAM_WORKSPACE_IPC } from "../../shared/ipc/team-workspace";
import { registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export function registerTeamWorkspaceIpc(ipc: IpcMainRegistrar, service: TeamWorkspaceService): () => void {
  const owners = new Map<number, { sender: WebContents; cancel(): void }>();
  const unregister = registerIpcHandler(ipc, TEAM_WORKSPACE_IPC, async (event, request) => {
    const owner = event.sender.id;
    if (!owners.has(owner)) {
      const cancel = () => { service.cancel(owner); owners.delete(owner); };
      owners.set(owner, { sender: event.sender, cancel });
      // Previews remain owned by this window between requests, until confirmed,
      // cancelled, expired, or the window closes.
      event.sender.once("destroyed", cancel);
    }
    return service.request(owner, request);
  });
  return () => {
    unregister();
    for (const [owner, { sender, cancel }] of owners) { sender.removeListener("destroyed", cancel); service.cancel(owner); }
    owners.clear();
  };
}
