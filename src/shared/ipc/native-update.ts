import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);

export const NATIVE_UPDATE_IPC = {
  getState: defineIpcRequest("native-update:get-state", noInput),
  check: defineIpcRequest("native-update:check", noInput),
  download: defineIpcRequest("native-update:download", noInput),
  install: defineIpcRequest("native-update:install", noInput),
  retry: defineIpcRequest("native-update:retry", noInput),
  copyDiagnostics: defineIpcRequest("native-update:copy-diagnostics", noInput),
  openHelp: defineIpcRequest("native-update:open-help", noInput),
  openReleases: defineIpcRequest("native-update:open-releases", noInput),
} as const;

export const NATIVE_UPDATE_EVENTS = {
  state: "native-update:state",
} as const;
