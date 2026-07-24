import { assertSafeArchiveEntry, type OpenVikingRuntimeManifest } from "./openviking-runtime-service";

export const OPENVIKING_RUNTIME_VERSION = "0.4.11";

interface RuntimeArtifactRecord {
  version?: unknown;
  platform?: unknown;
  arch?: unknown;
  sha256?: unknown;
  archiveType?: unknown;
  executablePath?: unknown;
  file?: unknown;
}

interface ResolveRuntimeManifestOptions {
  appVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseBaseUrl?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  developmentFallback?: () => Promise<OpenVikingRuntimeManifest | null>;
}

export async function resolveOpenVikingRuntimeManifest(
  options: ResolveRuntimeManifestOptions,
): Promise<OpenVikingRuntimeManifest | null> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertToken(options.appVersion, "AgentRecall version");
  assertToken(platform, "platform");
  assertToken(arch, "architecture");
  const artifactName = `openviking-runtime-${OPENVIKING_RUNTIME_VERSION}-${platform}-${arch}.tar.gz`;
  const releaseBase = options.releaseBaseUrl
    ?? `https://github.com/zszz3/AgentRecall/releases/download/v${options.appVersion}`;
  if (!releaseBase.startsWith("https://")) {
    throw new Error("OpenViking release base URL must use HTTPS.");
  }
  const response = await (options.fetchImpl ?? fetch)(`${releaseBase}/${artifactName}.json`, {
    redirect: "follow",
  });
  if (response.status === 404) {
    return options.developmentFallback?.() ?? null;
  }
  if (!response.ok) {
    throw new Error(`OpenViking runtime manifest download failed with HTTP ${response.status}.`);
  }
  const record = await response.json() as RuntimeArtifactRecord;
  if (
    record.version !== OPENVIKING_RUNTIME_VERSION
    || record.platform !== platform
    || record.arch !== arch
  ) {
    throw new Error("OpenViking runtime manifest does not match this build and platform.");
  }
  if (record.file !== artifactName) {
    throw new Error("OpenViking runtime manifest contains an unexpected artifact file.");
  }
  if (record.archiveType !== "tar.gz") {
    throw new Error("OpenViking runtime manifest contains an unsupported archive type.");
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
    throw new Error("OpenViking runtime manifest checksum is invalid.");
  }
  if (typeof record.executablePath !== "string") {
    throw new Error("OpenViking runtime manifest executable path is invalid.");
  }
  assertSafeArchiveEntry(record.executablePath);
  return {
    version: OPENVIKING_RUNTIME_VERSION,
    platform,
    arch,
    url: `${releaseBase}/${artifactName}`,
    sha256: record.sha256,
    executablePath: record.executablePath,
    archiveType: "tar.gz",
  };
}

function assertToken(value: string, label: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(value)) {
    throw new Error(`OpenViking ${label} is invalid.`);
  }
}
