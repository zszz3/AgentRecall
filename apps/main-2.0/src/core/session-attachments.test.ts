import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeSessionAttachment } from "./session-attachments";
import type { SessionAttachment } from "./types";

function attachment(overrides: Partial<SessionAttachment>): SessionAttachment {
  return {
    id: "source-id",
    fileName: "pixel.png",
    mimeType: "image/png",
    previewKind: "image",
    status: "available",
    ...overrides,
  };
}

describe("session attachment materialization", () => {
  it.each([
    ["missing", 11],
    ["unsafe", 22],
    ["too_large", 33],
  ] as const)("preserves a loader-verified %s status and size without a source", (status, sizeBytes) => {
    expect(materializeSessionAttachment(attachment({ status, sizeBytes }), {
      cacheRoot: null,
      sessionFilePath: "/fixtures/session.jsonl",
      attachmentId: "stored-id",
      remainingSessionBytes: 100,
    })).toMatchObject({
      id: "stored-id",
      status,
      sizeBytes,
      cachePath: null,
    });
  });

  it("marks an unmaterializable available attachment missing without losing its known size", () => {
    expect(materializeSessionAttachment(attachment({ sizeBytes: 44 }), {
      cacheRoot: null,
      sessionFilePath: "/fixtures/session.jsonl",
      attachmentId: "stored-id",
      remainingSessionBytes: 100,
    })).toMatchObject({
      status: "missing",
      sizeBytes: 44,
      cachePath: null,
    });
  });

  it("rejects inline bytes that disagree with their declared size or SHA-256", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-v2-attachments-"));
    try {
      const bytes = Buffer.from("verified bytes");
      const source = { kind: "inline" as const, value: bytes.toString("base64") };
      const options = {
        cacheRoot: path.join(directory, "cache"),
        sessionFilePath: path.join(directory, "session.jsonl"),
        attachmentId: "stored-id",
        remainingSessionBytes: 1024,
      };

      expect(materializeSessionAttachment(attachment({
        source,
        sizeBytes: bytes.length + 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }), options)).toMatchObject({
        status: "unsafe",
        sizeBytes: bytes.length,
        cachePath: null,
      });
      expect(materializeSessionAttachment(attachment({
        source,
        sizeBytes: bytes.length,
        sha256: "0".repeat(64),
      }), options)).toMatchObject({
        status: "unsafe",
        sizeBytes: bytes.length,
        cachePath: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
