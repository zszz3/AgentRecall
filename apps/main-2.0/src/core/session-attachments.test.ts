import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeSessionAttachment } from "./session-attachments";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

const defaultHomeDir = os.homedir();
const originalAppData = process.env.APPDATA;

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  vi.mocked(os.homedir).mockReset().mockReturnValue(defaultHomeDir);
});

describe("session attachments (V2)", () => {
  it("materializes bounded inline image data into the managed cache", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-attachments-"));
    try {
      const result = materializeSessionAttachment({
        id: "image",
        fileName: "shot.png",
        mimeType: "image/png",
        previewKind: "image",
        status: "available",
        source: { kind: "inline", value: Buffer.from("image bytes").toString("base64") },
      }, {
        cacheRoot: path.join(directory, "cache"),
        sessionFilePath: path.join(directory, "session.jsonl"),
        attachmentId: "0-0-image",
        remainingSessionBytes: 1024,
      });

      expect(result).toMatchObject({ status: "available", sizeBytes: 11 });
      expect(readFileSync(result.cachePath!, "utf8")).toBe("image bytes");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("trusts Antigravity conversation media file:// URIs while rejecting outside paths and symlinks", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-ag-attachments-"));
    try {
      const conversationRoot = path.join(directory, ".gemini", "antigravity", "brain", "conv-1");
      const logsDir = path.join(conversationRoot, ".system_generated", "logs");
      const uploadDir = path.join(conversationRoot, ".user_uploaded");
      const cacheRoot = path.join(directory, "cache");
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(uploadDir, { recursive: true });

      const sessionFilePath = path.join(logsDir, "transcript_full.jsonl");
      const uploadedImage = path.join(uploadDir, "media 1.png");
      const outsideFile = path.join(directory, "secret.png");
      const symlinkImage = path.join(uploadDir, "link.png");
      writeFileSync(sessionFilePath, "{}\n", "utf8");
      writeFileSync(uploadedImage, "png-bytes", "utf8");
      writeFileSync(outsideFile, "outside-bytes", "utf8");
      let symlinkCreated = false;
      try {
        symlinkSync(outsideFile, symlinkImage);
        symlinkCreated = true;
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }

      const options = {
        cacheRoot,
        sessionFilePath,
        attachmentId: "0-0-media",
        remainingSessionBytes: 1024,
      };
      const base = {
        id: "attachment-1",
        fileName: "media 1.png",
        mimeType: "image/png",
        previewKind: "image" as const,
        status: "available" as const,
      };

      const available = materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: pathToFileURL(uploadedImage).href },
      }, options);
      expect(available.status).toBe("available");
      expect(readFileSync(available.cachePath!, "utf8")).toBe("png-bytes");

      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: pathToFileURL(outsideFile).href },
      }, options).status).toBe("unsafe");

      if (symlinkCreated) {
        expect(materializeSessionAttachment({
          ...base,
          source: { kind: "path", value: pathToFileURL(symlinkImage).href },
        }, options).status).toBe("unsafe");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("trusts Windows Cursor AppData and APPDATA attachment roots while keeping custom homeDir isolated", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-cursor-attachments-"));
    try {
      const syntheticHome = path.join(directory, "home");
      const systemAppData = path.join(directory, "system-appdata");
      const roamingCursorFile = path.join(syntheticHome, "AppData", "Roaming", "Cursor", "blob.png");
      const macCursorFile = path.join(syntheticHome, "Library", "Application Support", "Cursor", "mac.png");
      const appDataCursorFile = path.join(systemAppData, "Cursor", "roaming.png");
      const outsideFile = path.join(directory, "outside.png");
      const sessionDir = path.join(syntheticHome, ".cursor", "projects", "repo", "agent-transcripts", "s1");
      const cacheRoot = path.join(directory, "cache");
      for (const file of [roamingCursorFile, macCursorFile, appDataCursorFile, outsideFile]) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "bytes", "utf8");
      }
      mkdirSync(sessionDir, { recursive: true });
      const sessionFilePath = path.join(sessionDir, "s1.jsonl");
      writeFileSync(sessionFilePath, "{}\n", "utf8");

      process.env.APPDATA = systemAppData;
      vi.mocked(os.homedir).mockReturnValue(syntheticHome);

      const base = {
        id: "cursor-img",
        fileName: "img.png",
        mimeType: "image/png",
        previewKind: "image" as const,
        status: "available" as const,
      };
      const defaultHomeOptions = {
        cacheRoot,
        sessionFilePath,
        attachmentId: "0-0-cursor-img",
        remainingSessionBytes: 1024,
      };

      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: roamingCursorFile },
      }, defaultHomeOptions).status).toBe("available");
      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: macCursorFile },
      }, defaultHomeOptions).status).toBe("available");
      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: appDataCursorFile },
      }, defaultHomeOptions).status).toBe("available");
      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: outsideFile },
      }, defaultHomeOptions).status).toBe("unsafe");

      const isolatedHome = path.join(directory, "isolated-home");
      const isolatedRoamingCursorFile = path.join(isolatedHome, "AppData", "Roaming", "Cursor", "isolated.png");
      mkdirSync(path.dirname(isolatedRoamingCursorFile), { recursive: true });
      writeFileSync(isolatedRoamingCursorFile, "bytes", "utf8");
      const isolatedOptions = { ...defaultHomeOptions, homeDir: isolatedHome };

      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: isolatedRoamingCursorFile },
      }, isolatedOptions).status).toBe("available");
      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: appDataCursorFile },
      }, isolatedOptions).status).toBe("unsafe");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
