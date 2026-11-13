import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isExecutableAttachmentPath,
  materializeSessionAttachment,
  shouldRevealExecutableAttachment,
} from "./session-attachments";

describe("session attachments", () => {
  it("materializes bounded inline image data into the managed cache", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachments-"));
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
        allowPathSources: true,
      });

      expect(result).toMatchObject({ status: "available", sizeBytes: 11 });
      expect(readFileSync(result.cachePath!, "utf8")).toBe("image bytes");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("copies an explicit regular file beside the session but rejects an unrelated path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachments-"));
    try {
      const sessionDirectory = path.join(directory, "sessions");
      const cacheRoot = path.join(directory, "cache");
      mkdirSync(sessionDirectory, { recursive: true });
      const trustedPath = path.join(sessionDirectory, "note.txt");
      const unrelatedPath = path.join(directory, "outside.txt");
      writeFileSync(trustedPath, "trusted", "utf8");
      writeFileSync(unrelatedPath, "outside", "utf8");
      const base = {
        id: "file",
        fileName: "note.txt",
        mimeType: "text/plain",
        previewKind: "text" as const,
        status: "available" as const,
      };
      const options = {
        cacheRoot,
        sessionFilePath: path.join(sessionDirectory, "session.jsonl"),
        attachmentId: "0-0-file",
        remainingSessionBytes: 1024,
        allowPathSources: true,
      };

      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: trustedPath },
      }, options).status).toBe("available");
      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: unrelatedPath },
      }, options).status).toBe("unsafe");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores path sources for sessions that were not written on this machine", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachments-"));
    try {
      const sessionDirectory = path.join(directory, "sessions");
      mkdirSync(sessionDirectory, { recursive: true });
      const localPath = path.join(sessionDirectory, "note.txt");
      writeFileSync(localPath, "local secret", "utf8");

      const result = materializeSessionAttachment({
        id: "file",
        fileName: "note.txt",
        mimeType: "text/plain",
        previewKind: "text",
        status: "available",
        source: { kind: "path", value: localPath },
      }, {
        cacheRoot: path.join(directory, "cache"),
        sessionFilePath: path.join(sessionDirectory, "session.jsonl"),
        attachmentId: "0-0-file",
        remainingSessionBytes: 1024,
        allowPathSources: false,
      });

      expect(result).toMatchObject({ status: "unsafe", cachePath: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never caches an attachment under an executable extension", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachments-"));
    try {
      const result = materializeSessionAttachment({
        id: "script",
        fileName: "run.BAT",
        mimeType: "application/octet-stream",
        previewKind: "file",
        status: "available",
        source: { kind: "inline", value: Buffer.from("calc.exe").toString("base64") },
      }, {
        cacheRoot: path.join(directory, "cache"),
        sessionFilePath: path.join(directory, "session.jsonl"),
        attachmentId: "0-0-script",
        remainingSessionBytes: 1024,
        allowPathSources: false,
      });

      expect(result.status).toBe("available");
      expect(path.extname(result.cachePath!)).toBe("");
      expect(isExecutableAttachmentPath(result.cachePath!)).toBe(false);
      expect(shouldRevealExecutableAttachment(result.fileName, result.cachePath!)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flags executable attachment paths but not documents", () => {
    for (const name of ["a.bat", "a.HTA", "a.ps1", "a.lnk", "a.command", "a.exe"]) {
      expect(isExecutableAttachmentPath(name)).toBe(true);
    }
    for (const name of ["a.png", "a.pdf", "a.txt", "a.docx", "a"]) {
      expect(isExecutableAttachmentPath(name)).toBe(false);
    }
    expect(shouldRevealExecutableAttachment("run.txt", "/cache/legacy.BAT")).toBe(true);
    expect(shouldRevealExecutableAttachment("run.BAT", "/cache/hash")).toBe(true);
  });

  it("trusts Antigravity conversation media file:// URIs while rejecting outside paths and symlinks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-ag-attachments-"));
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
      symlinkSync(outsideFile, symlinkImage);

      const options = {
        cacheRoot,
        sessionFilePath,
        attachmentId: "0-0-media",
        remainingSessionBytes: 1024,
        allowPathSources: true,
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

      expect(materializeSessionAttachment({
        ...base,
        source: { kind: "path", value: pathToFileURL(symlinkImage).href },
      }, options).status).toBe("unsafe");

      const deletedInConversation = path.join(uploadDir, "deleted.png");
      expect(materializeSessionAttachment({
        ...base,
        fileName: "deleted.png",
        source: { kind: "path", value: pathToFileURL(deletedInConversation).href },
      }, options).status).toBe("missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
