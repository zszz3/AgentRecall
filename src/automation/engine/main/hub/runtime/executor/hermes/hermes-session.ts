import { AcpInteractiveSession, type AcpInteractiveSessionOptions } from "../../../../agents/acp/acp-interactive-session";
import type { InteractiveSessionContext } from "../../../../agents/runtime/runtime-driver";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";

type HermesInteractiveSessionOptions = Omit<AcpInteractiveSessionOptions, "runtimeLabel" | "runtimeStateCodec">;

export class HermesInteractiveSession extends AcpInteractiveSession {
  constructor(context: InteractiveSessionContext, options: HermesInteractiveSessionOptions) {
    super(context, {
      ...options,
      runtimeLabel: "Hermes",
      runtimeStateCodec: hermesRuntimeStateCodec,
    });
  }
}
