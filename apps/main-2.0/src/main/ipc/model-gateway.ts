import {
  MODEL_GATEWAY_IPC,
  type GatewayAgentId,
  type GatewayRouteTarget,
  type GatewaySaveProviderInput,
  type GatewaySnapshot,
  type GatewayWiringActionResult,
} from "../../shared/ipc/model-gateway";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface ModelGatewayIpcService {
  getSnapshot(): Promise<GatewaySnapshot>;
  setEnabled(enabled: boolean, port?: number): Promise<GatewaySnapshot>;
  saveProvider(input: GatewaySaveProviderInput): Promise<GatewaySnapshot>;
  removeProvider(providerId: string): Promise<GatewaySnapshot>;
  setRouting(primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]): Promise<GatewaySnapshot>;
  setAgentModel(agentId: GatewayAgentId, target: GatewayRouteTarget | null): Promise<GatewaySnapshot>;
  wireAgent(agentId: GatewayAgentId): Promise<GatewayWiringActionResult>;
  restoreAgent(agentId: GatewayAgentId): Promise<GatewayWiringActionResult>;
  clearRequests(): Promise<GatewaySnapshot>;
}

export function registerModelGatewayIpc(
  ipc: IpcMainRegistrar,
  service: ModelGatewayIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.getSnapshot, () => service.getSnapshot()),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.setEnabled, (_event, input) => service.setEnabled(input.enabled, input.port)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.saveProvider, (_event, input) => service.saveProvider(input)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.removeProvider, (_event, id) => service.removeProvider(id)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.setRouting, (_event, input) => service.setRouting(input.primary, input.fallbacks)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.setAgentModel, (_event, input) => service.setAgentModel(input.agentId, input.target)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.wireAgent, (_event, agentId) => service.wireAgent(agentId)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.restoreAgent, (_event, agentId) => service.restoreAgent(agentId)),
    registerIpcHandler(ipc, MODEL_GATEWAY_IPC.clearRequests, () => service.clearRequests()),
  ]);
}
