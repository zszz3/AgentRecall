import { app, clipboard, dialog, type BrowserWindow, type IpcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { parseMessageLink, parseMessageLocator, type MessageLocator } from "../../core/message-tools";
import { registerMessageLinks } from "../message-link-registration";
import { MESSAGE_TOOLS_CHANNELS as C } from "../../shared/ipc/message-tools";
import type { SessionStore } from "../../core/session-store";
import { MessageToolsService } from "../services/message-tools-service";

/** Queues cold-start links until the main renderer has mounted its listener. */
export class MessageLinkRouter {
  private pending: MessageLocator | null = null;
  private ready = false;

  constructor(private readonly show: () => BrowserWindow | null) {
    this.accept(process.argv);
    app.on("open-url", (event, url) => { event.preventDefault(); this.accept([url]); });
    app.on("second-instance", (_event, argv) => this.accept(argv));
  }

  start(): void {
    this.ready = true;
    if (this.pending) this.open(this.pending);
  }

  private accept(args: string[]): void {
    const locator = args.map(parseMessageLink).find((item) => item !== null);
    if (locator) this.open(locator);
  }

  open(locator: MessageLocator): void {
    this.pending = parseMessageLocator(locator);
    if (this.ready) this.show()?.webContents.send(C.open);
  }

  take(): MessageLocator | null {
    const value = this.pending;
    this.pending = null;
    return value;
  }
}

export function registerMessageToolsIpc(ipc: IpcMain, store: SessionStore,
  ensureDetails: (key: string) => Promise<void>, router: MessageLinkRouter): void {
  const service = new MessageToolsService(store, ensureDetails);
  const owners = new Set<number>();
  ipc.handle(C.list, (_event, key: unknown) => {
    if (typeof key !== "string" || !key || key.length > 2048) throw new Error("Invalid session.");
    return service.listBookmarks(key);
  });
  ipc.handle(C.set, (_event, key, index, saved) => service.setBookmark(key, index, saved));
  ipc.handle(C.remove, (_event, locator) => store.removeMessageBookmark(parseMessageLocator(locator)));
  ipc.handle(C.resolve, (_event, locator) => service.resolve(locator));
  ipc.handle(C.copyLink, async (_event, key, index) => {
    // Register only following an explicit link-copy action, not when the app starts.
    const link = await service.copyLink(key, index);
    await registerMessageLinks();
    clipboard.writeText(link);
  });
  ipc.handle(C.pending, () => router.take());
  ipc.handle(C.open, (_event, locator) => router.open(parseMessageLocator(locator)));
  ipc.handle(C.prepare, (event, key, format) => {
    if (!owners.has(event.sender.id)) {
      owners.add(event.sender.id);
      event.sender.once("destroyed", () => { service.release(event.sender.id); owners.delete(event.sender.id); });
    }
    return service.prepareExport(event.sender.id, key, format);
  });
  ipc.handle(C.custom, (event, id, value) => service.addCustom(event.sender.id, id, value));
  ipc.handle(C.save, async (event, id, choices) => {
    const content = service.exportContent(event.sender.id, id, choices);
    const result = await dialog.showSaveDialog({ title: "Save reviewed export / 保存已预览的导出",
      defaultPath: `conversation-reviewed.${content.extension}`,
      filters: [{ name: "Reviewed conversation", extensions: [content.extension] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, content.text, "utf8");
    service.release(event.sender.id);
    return true;
  });
  ipc.handle(C.release, (event) => service.release(event.sender.id));
}
