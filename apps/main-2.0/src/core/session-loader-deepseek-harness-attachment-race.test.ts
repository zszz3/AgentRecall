import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_ATTACHMENT_BYTES } from "./session-attachments";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];

function fixture(includeLarge = true): {
  dshHome: string;
  filePath: string;
  objectPath: string;
  outsidePath: string;
  largePath: string;
} {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-v2-attachment-race-"));
  roots.push(homeDir);
  const dshHome = path.join(homeDir, ".dsh");
  const filePath = path.join(
    dshHome,
    "sessions",
    "--workspace-dsh--",
    "attachment-race",
    "session.jsonl",
  );
  const digest = createHash("sha256").update(PNG).digest("hex");
  const objectPath = path.join(dshHome, "attachments", "v1", "objects", digest.slice(0, 2), digest);
  const outsidePath = path.join(homeDir, "outside.png");
  const largePath = path.join(homeDir, "large.png");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, PNG);
  fs.writeFileSync(outsidePath, PNG);
  if (includeLarge) {
    fs.closeSync(fs.openSync(largePath, "w"));
    fs.truncateSync(largePath, MAX_ATTACHMENT_BYTES + 1);
  }
  fs.writeFileSync(filePath, [
    {
      type: "session",
      version: 0,
      id: "attachment-race",
      createdAt: 1,
      cwd: "/workspace/dsh",
      delegationDepth: 0,
    },
    {
      type: "user/message",
      seq: 0,
      time: 2,
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [{
          type: "image",
          attachment: {
            attachmentId: `sha256:${digest}`,
            mediaType: "image/png",
            bytes: PNG.length,
            width: 1,
            height: 1,
          },
        }],
      },
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { dshHome, filePath, objectPath, outsidePath, largePath };
}

afterEach(() => {
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DeepSeek Harness attachment object race safety", () => {
  it("rejects link, directory, permission, and oversized replacements before reading object bytes", async () => {
    for (const mode of ["symlink", "directory", "eacces", "large"] as const) {
      const item = fixture(mode === "large");
      const mutableFs = require("node:fs") as typeof import("node:fs");
      const originalOpenSync = mutableFs.openSync;
      const originalReadSync = mutableFs.readSync;
      let replacementApplied = false;
      let objectDescriptor: number | null = null;
      let objectReads = 0;
      mutableFs.openSync = ((
        target: fs.PathLike,
        ...args: unknown[]
      ) => {
        if (String(target) === item.objectPath && !replacementApplied) {
          replacementApplied = true;
          if (mode === "eacces") {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          fs.renameSync(item.objectPath, `${item.objectPath}.original`);
          if (mode === "symlink") fs.symlinkSync(item.outsidePath, item.objectPath, "file");
          if (mode === "directory") fs.mkdirSync(item.objectPath);
          if (mode === "large") fs.renameSync(item.largePath, item.objectPath);
        }
        const descriptor = (originalOpenSync as (...input: unknown[]) => number)(target, ...args);
        if (String(target) === item.objectPath) objectDescriptor = descriptor;
        return descriptor;
      }) as typeof fs.openSync;
      mutableFs.readSync = ((
        descriptor: number,
        ...args: unknown[]
      ) => {
        if (descriptor === objectDescriptor) objectReads += 1;
        return (originalReadSync as (...input: unknown[]) => number)(descriptor, ...args);
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      vi.resetModules();
      try {
        const { loadDeepSeekHarnessSessionFile } = await import("./session-loaders/deepseek-harness");
        const loaded = loadDeepSeekHarnessSessionFile(item.filePath, item.dshHome);
        expect(replacementApplied).toBe(true);
        expect(loaded.messages[0].attachments?.[0]?.status)
          .toBe(mode === "large" ? "too_large" : "unsafe");
        expect(objectReads).toBe(0);
      } finally {
        mutableFs.openSync = originalOpenSync;
        mutableFs.readSync = originalReadSync;
        syncBuiltinESMExports();
        vi.resetModules();
      }
    }
  });

  it("rejects parent-directory symlink escapes before opening the transcript", async () => {
    if (process.platform === "win32") return;
    for (const level of ["session", "project"] as const) {
      const item = fixture(false);
      const sessionDir = path.dirname(item.filePath);
      const projectDir = path.dirname(sessionDir);
      const outsideTarget = path.join(path.dirname(item.dshHome), `outside-${level}`);
      const outsideFile = level === "session"
        ? path.join(outsideTarget, "session.jsonl")
        : path.join(outsideTarget, path.basename(sessionDir), "session.jsonl");
      fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
      fs.copyFileSync(item.filePath, outsideFile);

      const mutableFs = require("node:fs") as typeof import("node:fs");
      const originalOpenSync = mutableFs.openSync;
      let transcriptOpens = 0;
      mutableFs.openSync = ((
        target: fs.PathLike,
        ...args: unknown[]
      ) => {
        if (String(target) === item.filePath) transcriptOpens += 1;
        return (originalOpenSync as (...input: unknown[]) => number)(target, ...args);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      vi.resetModules();
      try {
        const { loadDeepSeekHarnessSessionFile } = await import("./session-loaders/deepseek-harness");
        const discovered = fs.statSync(item.filePath);
        const replacedPath = level === "session" ? sessionDir : projectDir;
        let replaced = false;
        const staleStat = {
          get mtimeMs(): number {
            if (!replaced) {
              fs.renameSync(replacedPath, `${replacedPath}.original`);
              fs.symlinkSync(outsideTarget, replacedPath, "dir");
              replaced = true;
            }
            return discovered.mtimeMs;
          },
          size: discovered.size,
        };

        expect(() => loadDeepSeekHarnessSessionFile(item.filePath, item.dshHome, staleStat))
          .toThrow("resolves outside the canonical sessions directory");
        expect(replaced).toBe(true);
        expect(transcriptOpens).toBe(0);
      } finally {
        mutableFs.openSync = originalOpenSync;
        syncBuiltinESMExports();
        vi.resetModules();
      }
    }
  });
});
