import type { IpcMainInvokeEvent, WebContents } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface CoreRendererLocation {
  productionFile: string;
  developmentUrl?: string;
}

export function isTrustedCoreIpcSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  expectedContents: Pick<WebContents, "id" | "mainFrame">,
  location: CoreRendererLocation,
): boolean {
  if (
    event.sender.id !== expectedContents.id
    || !event.senderFrame
    || event.senderFrame !== expectedContents.mainFrame
  ) {
    return false;
  }
  return isTrustedCoreRendererUrl(event.senderFrame.url, location);
}

export function isTrustedCoreRendererUrl(
  value: string,
  location: CoreRendererLocation,
): boolean {
  try {
    const candidate = new URL(value);
    if (location.developmentUrl) {
      const development = new URL(location.developmentUrl);
      return candidate.origin === development.origin;
    }
    if (candidate.protocol !== "file:") return false;
    return comparablePath(fileURLToPath(candidate)) === comparablePath(location.productionFile);
  } catch {
    return false;
  }
}

function comparablePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
