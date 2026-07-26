import { z } from "zod";
import { defineIpcRequest } from "./contract";

const optionalBooleanInput = z
  .union([z.tuple([]), z.tuple([z.boolean().optional()])])
  .transform((input): [boolean] => [input[0] ?? false]);

export const QUOTA_IPC = {
  get: defineIpcRequest("quota:get", optionalBooleanInput),
} as const;

export const QUOTA_EVENTS = {
  updated: "quota:updated",
} as const;
