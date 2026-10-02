import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isExecutableAttachmentPath, materializeSessionAttachment } from "./session-attachments";

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
  });
});
