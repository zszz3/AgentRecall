import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  GATEWAY_SNAPSHOT_CHANNEL,
  MODEL_GATEWAY_IPC,
  type GatewayAgentId,
  type GatewayRouteTarget,
  type GatewaySaveProviderInput,
  type GatewaySnapshot,
  type GatewayWiringActionResult,
} from "../shared/ipc/model-gateway";

export type ModelGatewayIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createModelGatewayApi(ipc: ModelGatewayIpcRenderer) {
  return {
    getGatewaySnapshot: (): Promise<GatewaySnapshot> => ipc.invoke(MODEL_GATEWAY_IPC.getSnapshot.channel),
    setGatewayEnabled: (enabled: boolean, port?: number): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.setEnabled.channel, { enabled, ...(port !== undefined ? { port } : {}) }),
    saveGatewayProvider: (input: GatewaySaveProviderInput): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.saveProvider.channel, input),
    removeGatewayProvider: (providerId: string): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.removeProvider.channel, providerId),
    setGatewayRouting: (primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.setRouting.channel, { primary, fallbacks }),
    setGatewayAgentModel: (agentId: GatewayAgentId, target: GatewayRouteTarget | null): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.setAgentModel.channel, { agentId, target }),
    wireGatewayAgent: (agentId: GatewayAgentId): Promise<GatewayWiringActionResult> =>
      ipc.invoke(MODEL_GATEWAY_IPC.wireAgent.channel, agentId),
    restoreGatewayAgent: (agentId: GatewayAgentId): Promise<GatewayWiringActionResult> =>
      ipc.invoke(MODEL_GATEWAY_IPC.restoreAgent.channel, agentId),
    clearGatewayRequests: (): Promise<GatewaySnapshot> =>
      ipc.invoke(MODEL_GATEWAY_IPC.clearRequests.channel),
    onGatewaySnapshot: (callback: (snapshot: GatewaySnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: GatewaySnapshot) => callback(snapshot);
      ipc.on(GATEWAY_SNAPSHOT_CHANNEL, listener);
      return () => ipc.removeListener(GATEWAY_SNAPSHOT_CHANNEL, listener);
    },
  };
}
