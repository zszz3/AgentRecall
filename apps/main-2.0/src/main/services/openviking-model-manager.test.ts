import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILTIN_OPENVIKING_MODEL_MANIFEST,
  OpenVikingLocalModelManager,
  resolveModelUrl,
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
  it("uses a configured absolute GGUF path without downloading the managed model", async () => {
    const directory = await root();
    const configuredModel = path.join(directory, "existing-model.gguf");
    await writeFile(configuredModel, "configured model");
    const manager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      configuredModelPath: () => configuredModel,
    });

    await expect(manager.getStatus()).resolves.toEqual({
      model: "BAAI/bge-small-zh-v1.5",
      installed: true,
      totalBytes: Buffer.byteLength("configured model"),
    });
    await expect(manager.getModelPath()).resolves.toBe(configuredModel);
  });

  it("reports configuration errors for invalid model paths", async () => {
    const directory = await root();
    const relativeManager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      configuredModelPath: () => "relative-model.gguf",
    });
    const missingManager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      configuredModelPath: () => path.join(directory, "missing.gguf"),
    });

    await expect(relativeManager.getStatus()).resolves.toMatchObject({
      installed: false,
      error: "OpenViking model path must be an absolute path.",
    });
    await expect(missingManager.getStatus()).resolves.toMatchObject({
      installed: false,
      error: "OpenViking model file was not found at the configured absolute path.",
    });
    await expect(relativeManager.getModelPath()).rejects.toThrow("absolute path");
  });

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

  it("discards the partial file when the checksum does not match so a retry restarts", async () => {
    const directory = await root();
    const partial = path.join(directory, "downloads", "bge-small-zh-v1.5-1.5-f16.gguf.part");
    const manager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      download: async (_url, destination) => writeFile(destination, "tampered"),
    });

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).rejects.toThrow("checksum");

    await expect(access(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the partial file after a failed transfer so the next attempt resumes it", async () => {
    const directory = await root();
    const partial = path.join(directory, "downloads", "bge-small-zh-v1.5-1.5-f16.gguf.part");
    let attempt = 0;
    const manager = new OpenVikingLocalModelManager({
      rootDir: directory,
      resolveManifest: async () => manifest,
      download: async (_url, destination) => {
        attempt += 1;
        if (attempt === 1) {
          await writeFile(destination, "model ");
          throw new Error("connection reset");
        }
        // The second attempt appends the remainder, exactly as a range request would.
        await writeFile(destination, `${await readFile(destination, "utf8")}archive`);
      },
    });

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).rejects.toThrow("connection reset");
    await expect(readFile(partial, "utf8")).resolves.toBe("model ");

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).resolves.toMatchObject({
      installed: true,
    });
  });

  it("redirects huggingface downloads to an HF_ENDPOINT mirror when one is configured", () => {
    const official = BUILTIN_OPENVIKING_MODEL_MANIFEST.url;

    expect(resolveModelUrl(official, {})).toBe(official);
    expect(resolveModelUrl(official, { HF_ENDPOINT: "https://hf-mirror.com" })).toBe(
      "https://hf-mirror.com/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true",
    );
    expect(resolveModelUrl(official, { HF_ENDPOINT: "https://mirror.example/hf/" })).toBe(
      "https://mirror.example/hf/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true",
    );
    expect(resolveModelUrl("https://downloads.example/model.gguf", {
      HF_ENDPOINT: "https://hf-mirror.com",
    })).toBe("https://downloads.example/model.gguf");
    expect(() => resolveModelUrl(official, { HF_ENDPOINT: "http://hf-mirror.com" }))
      .toThrow("HTTPS");
  });

  it("downloads the model through the configured mirror", async () => {
    const requested: string[] = [];
    const manager = new OpenVikingLocalModelManager({
      rootDir: await root(),
      resolveManifest: async () => ({
        ...manifest,
        url: "https://huggingface.co/CompendiumLabs/bge/resolve/main/model.gguf",
      }),
      env: { HF_ENDPOINT: "https://hf-mirror.com" },
      download: async (url, destination) => {
        requested.push(url);
        await writeFile(destination, "model archive");
      },
    });

    await expect(manager.install("BAAI/bge-small-zh-v1.5")).resolves.toMatchObject({
      installed: true,
    });
    expect(requested).toEqual([
      "https://hf-mirror.com/CompendiumLabs/bge/resolve/main/model.gguf",
    ]);
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
