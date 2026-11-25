import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  ISLAND_IPC,
  ISLAND_SNAPSHOT_CHANNEL,
  SHARE_SESSION_TO_TEAM_CHANNEL,
  type IslandFocusResult,
  type IslandSnapshot,
} from "../shared/ipc/island";

export type IslandIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createIslandApi(ipc: IslandIpcRenderer) {
  return {
    getIslandSnapshot: (): Promise<IslandSnapshot> => ipc.invoke(ISLAND_IPC.getSnapshot.channel),
    focusIslandTask: (taskId: string): Promise<IslandFocusResult> => ipc.invoke(ISLAND_IPC.focusTask.channel, taskId),
    openIslandTrajectory: (taskId: string): Promise<void> => ipc.invoke(ISLAND_IPC.openTrajectory.channel, taskId),
    shareIslandTaskToTeam: (taskId: string): Promise<void> => ipc.invoke(ISLAND_IPC.shareToTeam.channel, taskId),
    dismissIslandTask: (taskId: string): Promise<IslandSnapshot> => ipc.invoke(ISLAND_IPC.dismissTask.channel, taskId),
    clearCompletedIslandTasks: (): Promise<IslandSnapshot> => ipc.invoke(ISLAND_IPC.clearCompleted.channel),
    setIslandMuted: (muted: boolean): Promise<IslandSnapshot> => ipc.invoke(ISLAND_IPC.setMuted.channel, muted),
    setIslandInteractive: (interactive: boolean): Promise<void> => ipc.invoke(ISLAND_IPC.setInteractive.channel, interactive),
    closeIsland: (): Promise<IslandSnapshot> => ipc.invoke(ISLAND_IPC.close.channel),
    onIslandSnapshot: (callback: (snapshot: IslandSnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: IslandSnapshot) => callback(snapshot);
      ipc.on(ISLAND_SNAPSHOT_CHANNEL, listener);
      return () => ipc.removeListener(ISLAND_SNAPSHOT_CHANNEL, listener);
    },
    onShareSessionToTeam: (callback: (sessionKey: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionKey: string) => callback(sessionKey);
      ipc.on(SHARE_SESSION_TO_TEAM_CHANNEL, listener);
      return () => ipc.removeListener(SHARE_SESSION_TO_TEAM_CHANNEL, listener);
    },
  };
}
