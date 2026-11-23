import { z } from "zod";
import { defineIpcRequest } from "./contract";

export type { InstructionFile } from "../../core/instruction-files";

const file = z.string().min(1).max(4_096);

export const INSTRUCTIONS_IPC = {
  list: defineIpcRequest("instructions:list", z.tuple([])),
  read: defineIpcRequest("instructions:read", z.tuple([file])),
  open: defineIpcRequest("instructions:open", z.tuple([file])),
  reveal: defineIpcRequest("instructions:reveal", z.tuple([file])),
};
