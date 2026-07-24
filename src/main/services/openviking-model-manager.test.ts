import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILTIN_OPENVIKING_MODEL_MANIFEST,
  OpenVikingLocalModelManager,
  type OpenVikingModelManifest,
} from "./openviking-model-manager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-model-"));
  roots.push(value);
  return value;
}

const manifest: OpenVikingModelManifest = {
  model: "BAAI/bge-small-zh-v1.5",
  version: "1.5-f16",
  url: "https://downloads.example/bge-small-zh-v1.5.tar.gz",
  sha256: createHash("sha256").update("model archive").digest("hex"),
  artifactType: "gguf",
  fileName: "bge-small-zh-v1.5-f16.gguf",
  size: 47_886_240,
};

describe("OpenVikingLocalModelManager", () => {
  it("pins the official GGUF artifact selected for local memory", () => {
    expect(BUILTIN_OPENVIKING_MODEL_MANIFEST).toEqual({
      model: "BAAI/bge-small-zh-v1.5",
      version: "1.5-f16",
      url: "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true",
      sha256: "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c",
      artifactType: "gguf",
      fileName: "bge-small-zh-v1.5-f16.gguf",
      size: 47_886_240,
    });
  });

  it("downloads, verifies and activates the one supported local model", async () => {
    const directory = await root();
    const manager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      download: async (_url, destination) => writeFile(destination, "model archive"),
    });

    await expect(manager.getStatus()).resolves.toEqual({
      model: "BAAI/bge-small-zh-v1.5",
      installed: false,
      totalBytes: 47_886_240,
    });
    await expect(manager.install("BAAI/bge-small-zh-v1.5")).resolves.toMatchObject({
      model: "BAAI/bge-small-zh-v1.5",
      installed: true,
      totalBytes: 47_886_240,
    });
    await expect(manager.getModelPath()).resolves.toBe(
      path.join(
        directory,
        "models",
        "bge-small-zh-v1.5",
        "1.5-f16",
        "bge-small-zh-v1.5-f16.gguf",
      ),
    );
  });

  it("rejects a mismatched model checksum before activation", async () => {
    const directory = await root();
    const manager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      download: async (_url, destination) => writeFile(destination, "tampered"),
    });

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).rejects.toThrow("checksum");
    await expect(manager.getStatus()).resolves.toMatchObject({ installed: false });
  });

  it("reports a clear error when this build has no model artifact", async () => {
    const manager = new OpenVikingLocalModelManager({
      rootDir: await root(),
      resolveManifest: async () => null,
    });

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).rejects.toThrow(
      "not available for this build",
    );
  });
});
