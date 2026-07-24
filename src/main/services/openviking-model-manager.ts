import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  OPENVIKING_LOCAL_EMBEDDING_MODEL,
  type OpenVikingModelStatus,
} from "../../core/openviking-memory";
import { assertSafeArchiveEntry } from "./openviking-runtime-service";

export interface OpenVikingModelManifest {
  model: typeof OPENVIKING_LOCAL_EMBEDDING_MODEL;
  version: string;
  url: string;
  sha256: string;
  artifactType: "gguf";
  fileName: string;
  size: number;
}

export const BUILTIN_OPENVIKING_MODEL_MANIFEST: OpenVikingModelManifest = Object.freeze({
  model: OPENVIKING_LOCAL_EMBEDDING_MODEL,
  version: "1.5-f16",
  url: "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true",
  sha256: "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c",
  artifactType: "gguf",
  fileName: "bge-small-zh-v1.5-f16.gguf",
  size: 47_886_240,
});

interface OpenVikingLocalModelManagerOptions {
  rootDir: string;
  resolveManifest(): Promise<OpenVikingModelManifest | null>;
  download?: (url: string, destination: string) => Promise<void>;
}

export class OpenVikingLocalModelManager {
  private readonly rootDir: string;
  private readonly download: NonNullable<OpenVikingLocalModelManagerOptions["download"]>;

  constructor(private readonly options: OpenVikingLocalModelManagerOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.download = options.download ?? downloadFile;
  }

  async getStatus(): Promise<OpenVikingModelStatus> {
    const [active, available] = await Promise.all([
      this.readActiveManifest(),
      this.options.resolveManifest(),
    ]);
    if (active) {
      try {
        await access(this.modelPath(active));
        return {
          model: OPENVIKING_LOCAL_EMBEDDING_MODEL,
          installed: true,
          totalBytes: active.size,
        };
      } catch {
        // A partially removed model is treated as not installed.
      }
    }
    return {
      model: OPENVIKING_LOCAL_EMBEDDING_MODEL,
      installed: false,
      ...(available ? { totalBytes: available.size } : {}),
    };
  }

  async install(
    model: typeof OPENVIKING_LOCAL_EMBEDDING_MODEL,
  ): Promise<OpenVikingModelStatus> {
    if (model !== OPENVIKING_LOCAL_EMBEDDING_MODEL) {
      throw new Error(`Unsupported OpenViking embedding model: ${model}`);
    }
    const manifest = await this.options.resolveManifest();
    if (!manifest) throw new Error("OpenViking embedding model is not available for this build.");
    validateManifest(manifest);
    const modelsRoot = this.ownedPath("models");
    const downloadsRoot = this.ownedPath("downloads");
    const modelRoot = path.join(modelsRoot, "bge-small-zh-v1.5");
    const target = path.join(modelRoot, manifest.version);
    const staging = path.join(modelRoot, `.staging-${manifest.version}-${randomUUID()}`);
    const partial = path.join(downloadsRoot, `bge-small-zh-v1.5-${manifest.version}.gguf.part`);
    try {
      await mkdir(downloadsRoot, { recursive: true });
      await mkdir(modelRoot, { recursive: true });
      await rm(partial, { force: true });
      await this.download(manifest.url, partial);
      const actualSha = await sha256File(partial);
      if (actualSha !== manifest.sha256.toLowerCase()) {
        throw new Error(`OpenViking model checksum mismatch: expected ${manifest.sha256}, received ${actualSha}.`);
      }
      await mkdir(staging, { recursive: true });
      await rename(partial, resolveModelFile(staging, manifest.fileName));
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      await writeFile(this.activeManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return this.getStatus();
    } catch (error) {
      await rm(partial, { force: true });
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async getModelPath(): Promise<string> {
    const manifest = await this.readActiveManifest();
    if (!manifest) throw new Error("OpenViking embedding model is not installed.");
    const modelPath = this.modelPath(manifest);
    await access(modelPath);
    return modelPath;
  }

  private modelDirectory(manifest: OpenVikingModelManifest): string {
    return this.ownedPath("models", "bge-small-zh-v1.5", manifest.version);
  }

  private modelPath(manifest: OpenVikingModelManifest): string {
    return resolveModelFile(this.modelDirectory(manifest), manifest.fileName);
  }

  private activeManifestPath(): string {
    return this.ownedPath("models", "active-model.json");
  }

  private async readActiveManifest(): Promise<OpenVikingModelManifest | null> {
    try {
      return JSON.parse(await readFile(this.activeManifestPath(), "utf8")) as OpenVikingModelManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private ownedPath(...segments: string[]): string {
    const resolved = path.resolve(this.rootDir, ...segments);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("OpenViking model path escaped the application-owned directory.");
    }
    return resolved;
  }
}

function validateManifest(manifest: OpenVikingModelManifest): void {
  if (manifest.model !== OPENVIKING_LOCAL_EMBEDDING_MODEL) {
    throw new Error("OpenViking model manifest has an unexpected model ID.");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(manifest.version)) {
    throw new Error("OpenViking model manifest version is invalid.");
  }
  if (!manifest.url.startsWith("https://")) throw new Error("OpenViking model URL must use HTTPS.");
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256.toLowerCase())) {
    throw new Error("OpenViking model checksum is invalid.");
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
    throw new Error("OpenViking model size is invalid.");
  }
  if (manifest.artifactType !== "gguf") {
    throw new Error("OpenViking model artifact must be a GGUF file.");
  }
  assertSafeArchiveEntry(manifest.fileName);
  if (!manifest.fileName.endsWith(".gguf")) {
    throw new Error("OpenViking model file must use the .gguf extension.");
  }
}

function resolveModelFile(directory: string, file: string): string {
  assertSafeArchiveEntry(file);
  const resolved = path.resolve(directory, ...file.replaceAll("\\", "/").split("/"));
  const relative = path.relative(directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe OpenViking model file: ${file}`);
  }
  return resolved;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`OpenViking model download failed with HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destination, { mode: 0o600 }),
  );
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
