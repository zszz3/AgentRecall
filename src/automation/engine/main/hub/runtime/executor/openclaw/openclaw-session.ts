import { AcpInteractiveSession, type AcpInteractiveSessionOptions } from "../../../../agents/acp/acp-interactive-session";
import type { InteractiveSessionContext } from "../../../../agents/runtime/runtime-driver";
import { openClawRuntimeStateCodec } from "../../../../agents/openclaw/openclaw-runtime-state-codec";

type OpenClawInteractiveSessionOptions = Omit<AcpInteractiveSessionOptions, "runtimeLabel" | "runtimeStateCodec">;

export class OpenClawInteractiveSession extends AcpInteractiveSession {
  constructor(context: InteractiveSessionContext, options: OpenClawInteractiveSessionOptions) {
    super(context, {
      ...options,
      runtimeLabel: "OpenClaw",
      runtimeStateCodec: openClawRuntimeStateCodec,
    });
  }
}
