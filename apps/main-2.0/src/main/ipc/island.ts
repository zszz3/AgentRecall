import { ISLAND_IPC, type IslandFocusResult, type IslandSnapshot } from "../../shared/ipc/island";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface IslandIpcService {
  getSnapshot(): IslandSnapshot;
  focusTask(taskId: string): Promise<IslandFocusResult>;
  openTrajectory(taskId: string): Promise<void>;
  shareToTeam(taskId: string): Promise<void>;
  dismissTask(taskId: string): IslandSnapshot;
  clearCompleted(): IslandSnapshot;
  setMuted(muted: boolean): IslandSnapshot;
  setInteractive(interactive: boolean): void;
  resizeBounds(width: number, height: number): void;
  sendTestAlert(kind?: "completed" | "waiting_input" | "error"): Promise<IslandSnapshot>;
}

export function registerIslandIpc(
  ipc: IpcMainRegistrar,
  service: IslandIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, ISLAND_IPC.getSnapshot, () => service.getSnapshot()),
    registerIpcHandler(ipc, ISLAND_IPC.focusTask, (_event, taskId) => service.focusTask(taskId)),
    registerIpcHandler(ipc, ISLAND_IPC.openTrajectory, (_event, taskId) => service.openTrajectory(taskId)),
    registerIpcHandler(ipc, ISLAND_IPC.shareToTeam, (_event, taskId) => service.shareToTeam(taskId)),
    registerIpcHandler(ipc, ISLAND_IPC.dismissTask, (_event, taskId) => service.dismissTask(taskId)),
    registerIpcHandler(ipc, ISLAND_IPC.clearCompleted, () => service.clearCompleted()),
    registerIpcHandler(ipc, ISLAND_IPC.setMuted, (_event, muted) => service.setMuted(muted)),
    registerIpcHandler(ipc, ISLAND_IPC.setInteractive, (_event, interactive) => service.setInteractive(interactive)),
    registerIpcHandler(ipc, ISLAND_IPC.resizeBounds, (_event, bounds) => service.resizeBounds(bounds.width, bounds.height)),
    registerIpcHandler(ipc, ISLAND_IPC.sendTestAlert, (_event, kind) => service.sendTestAlert(kind)),
  ]);
}
