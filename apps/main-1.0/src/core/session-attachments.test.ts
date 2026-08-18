import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeSessionAttachment } from "./session-attachments";

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

  it("preserves loader-classified unavailable attachment statuses", () => {
    const options = {
      cacheRoot: "/unused",
      sessionFilePath: "/unused/session.jsonl",
      attachmentId: "materialized-id",
      remainingSessionBytes: 1024,
    };
    const base = {
      id: "source-id",
      fileName: "shot.png",
      mimeType: "image/png",
      previewKind: "image" as const,
      remoteObjectKey: "attachments/object",
      sha256: "a".repeat(64),
    };

    expect(materializeSessionAttachment({
      ...base,
      status: "missing",
      sizeBytes: 7,
    }, options)).toEqual({
      ...base,
      id: "materialized-id",
      status: "missing",
      sizeBytes: 7,
      remoteObjectKey: "attachments/object",
      sha256: "a".repeat(64),
      cachePath: null,
    });
    expect(materializeSessionAttachment({
      ...base,
      status: "unsafe",
    }, options)).toEqual({
      ...base,
      id: "materialized-id",
      status: "unsafe",
      sizeBytes: undefined,
      remoteObjectKey: "attachments/object",
      sha256: "a".repeat(64),
      cachePath: null,
    });
  });

  it("rejects inline attachment bytes that disagree with declared size or SHA-256", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-attachments-"));
    try {
      const bytes = Buffer.from("verified bytes");
      const base = {
        id: "image",
        fileName: "shot.png",
        mimeType: "image/png",
        previewKind: "image" as const,
        status: "available" as const,
        source: { kind: "inline" as const, value: bytes.toString("base64") },
      };
      const options = {
        cacheRoot: path.join(directory, "cache"),
        sessionFilePath: path.join(directory, "session.jsonl"),
        attachmentId: "0-0-image",
        remainingSessionBytes: 1024,
      };

      expect(materializeSessionAttachment({
        ...base,
        sizeBytes: bytes.length + 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }, options)).toMatchObject({
        status: "unsafe",
        sizeBytes: bytes.length,
        cachePath: null,
      });
      expect(materializeSessionAttachment({
        ...base,
        sizeBytes: bytes.length,
        sha256: "0".repeat(64),
      }, options)).toMatchObject({
        status: "unsafe",
        sizeBytes: bytes.length,
        cachePath: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
