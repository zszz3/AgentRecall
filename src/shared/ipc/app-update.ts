import { z } from "zod";
import { defineIpcRequest } from "./contract";

const optionalBooleanInput = z
  .union([z.tuple([]), z.tuple([z.boolean().optional()])])
  .transform((input): [boolean] => [input[0] ?? false]);

export const APP_UPDATE_IPC = {
  getStatus: defineIpcRequest("app-update:get-status", optionalBooleanInput),
  install: defineIpcRequest("app-update:install", z.tuple([])),
  skip: defineIpcRequest("app-update:skip", optionalBooleanInput),
} as const;

export const APP_UPDATE_EVENTS = {
  status: "app-update:status",
  progress: "app-update:progress",
} as const;
