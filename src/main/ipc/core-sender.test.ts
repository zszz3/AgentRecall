import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isTrustedCoreIpcSender,
  isTrustedCoreRendererUrl,
} from "./core-sender";

describe("Core IPC sender boundary", () => {
  it("accepts only the expected production renderer file", () => {
    const rendererFile = path.resolve("out", "renderer", "index.html");
    const location = { productionFile: rendererFile };

    expect(
      isTrustedCoreRendererUrl(pathToFileURL(rendererFile).href, location),
    ).toBe(true);
    expect(
      isTrustedCoreRendererUrl(
        pathToFileURL(path.resolve("out", "renderer", "other.html")).href,
        location,
      ),
    ).toBe(false);
    expect(
      isTrustedCoreRendererUrl("https://example.com/index.html", location),
    ).toBe(false);
    expect(isTrustedCoreRendererUrl("not a url", location)).toBe(false);
  });

  it("accepts only the configured development origin", () => {
    const location = {
      productionFile: path.resolve("out", "renderer", "index.html"),
      developmentUrl: "http://127.0.0.1:5173/",
    };

    expect(
      isTrustedCoreRendererUrl("http://127.0.0.1:5173/settings", location),
    ).toBe(true);
    expect(
      isTrustedCoreRendererUrl("http://localhost:5173/", location),
    ).toBe(false);
    expect(
      isTrustedCoreRendererUrl("https://127.0.0.1:5173/", location),
    ).toBe(false);
  });

  it("rejects subframes and other webContents before checking the URL", () => {
    const mainFrame = {
      url: pathToFileURL(path.resolve("out", "renderer", "index.html")).href,
    };
    const expectedContents = { id: 7, mainFrame };
    const location = {
      productionFile: path.resolve("out", "renderer", "index.html"),
    };

    expect(
      isTrustedCoreIpcSender(
        { sender: { id: 7 }, senderFrame: mainFrame } as never,
        expectedContents as never,
        location,
      ),
    ).toBe(true);
    expect(
      isTrustedCoreIpcSender(
        { sender: { id: 8 }, senderFrame: mainFrame } as never,
        expectedContents as never,
        location,
      ),
    ).toBe(false);
    expect(
      isTrustedCoreIpcSender(
        {
          sender: { id: 7 },
          senderFrame: { url: mainFrame.url },
        } as never,
        expectedContents as never,
        location,
      ),
    ).toBe(false);
  });
});
