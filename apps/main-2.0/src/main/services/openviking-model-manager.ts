import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  OPENVIKING_LOCAL_EMBEDDING_MODEL,
  type OpenVikingModelStatus,
} from "../../core/openviking-memory";
import { downloadFileWithResume } from "./openviking-download";
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
  configuredModelPath?: () => string | undefined;
  download?: (url: string, destination: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export class OpenVikingLocalModelManager {
  private readonly rootDir: string;
  private readonly download: NonNullable<OpenVikingLocalModelManagerOptions["download"]>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: OpenVikingLocalModelManagerOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.download = options.download ?? downloadFileWithResume;
    this.env = options.env ?? process.env;
  }

  async getStatus(): Promise<OpenVikingModelStatus> {
    const configured = (this.options.configuredModelPath?.() ?? "").trim();
    if (configured) {
      try {
        const configuredPath = this.configuredPath(configured);
        const model = await this.requireConfiguredModel(configuredPath);
        return {
          model: OPENVIKING_LOCAL_EMBEDDING_MODEL,
          installed: true,
          totalBytes: model.size,
        };
      } catch (error) {
        return {
          model: OPENVIKING_LOCAL_EMBEDDING_MODEL,
          installed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
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
      // A partial file from an interrupted attempt is kept so the download resumes there.
      await this.download(resolveModelUrl(manifest.url, this.env), partial);
      const actualSha = await sha256File(partial);
      if (actualSha !== manifest.sha256.toLowerCase()) {
        // The bytes on disk are unusable, so a retry has to start over rather than resume.
        await rm(partial, { force: true });
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
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async getModelPath(): Promise<string> {
    const configured = (this.options.configuredModelPath?.() ?? "").trim();
    if (configured) {
      const configuredPath = this.configuredPath(configured);
      await this.requireConfiguredModel(configuredPath);
      return configuredPath;
    }
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

  async validateConfiguredPath(configuredPath?: string): Promise<void> {
    const configured = (configuredPath ?? "").trim();
    if (!configured) return;
    await this.requireConfiguredModel(this.configuredPath(configured));
  }

  private configuredPath(configured: string): string {
    if (!path.isAbsolute(configured)) {
      throw new Error("OpenViking model path must be an absolute path.");
    }
    return path.resolve(configured);
  }

  private async requireConfiguredModel(modelPath: string): Promise<{ size: number }> {
    if (!modelPath.toLowerCase().endsWith(".gguf")) {
      throw new Error("OpenViking model path must point to a .gguf file.");
    }
    try {
      const model = await stat(modelPath);
      if (!model.isFile()) throw new Error("Configured model path is not a file.");
      return { size: model.size };
    } catch (error) {
      if (error instanceof Error && error.message === "Configured model path is not a file.") throw error;
      throw new Error("OpenViking model file was not found at the configured absolute path.", { cause: error });
    }
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

/**
 * Redirects a huggingface.co artifact to the mirror named by `HF_ENDPOINT`, which is the
 * variable the Hugging Face client libraries already read. The default stays the official
 * host, and the manifest checksum is still enforced afterwards, so a mirror can only make
 * the download faster or fail — never substitute different bytes.
 */
export function resolveModelUrl(url: string, env: NodeJS.ProcessEnv): string {
  const endpoint = env.HF_ENDPOINT?.trim();
  if (!endpoint) return url;
  const source = new URL(url);
  if (source.hostname !== "huggingface.co") return url;
  const mirror = new URL(endpoint);
  if (mirror.protocol !== "https:") {
    throw new Error("HF_ENDPOINT must use HTTPS.");
  }
  source.protocol = mirror.protocol;
  source.host = mirror.host;
  source.pathname = `${trimTrailingSlash(mirror.pathname)}${source.pathname}`;
  return source.href;
}

function trimTrailingSlash(value: string): string {
  return value === "/" ? "" : value.replace(/\/$/u, "");
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

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
