import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpenVikingWorkspace } from "../../core/openviking-memory";
import type { OpenVikingWorkspaceAuth } from "./openviking-client";
import type { OpenVikingCredentialStorePort } from "./openviking-memory-service";

interface OpenVikingHookManifestServiceOptions {
  rootDir: string;
  credentials: Pick<OpenVikingCredentialStorePort, "get">;
  realpath(value: string): Promise<string>;
}

interface WriteOpenVikingHookManifestInput {
  baseUrl: string | null;
  integrations: {
    claude: boolean;
    codex: boolean;
    opencode: boolean;
  };
  workspaces: OpenVikingWorkspace[];
}

interface HookWorkspace extends OpenVikingWorkspaceAuth {
  id: string;
  rootPath: string;
}

export class OpenVikingHookManifestService {
  private readonly filePath: string;

  constructor(private readonly options: OpenVikingHookManifestServiceOptions) {
    this.filePath = path.join(path.resolve(options.rootDir), "hook-manifest.json");
  }

  manifestPath(): string {
    return this.filePath;
  }

  async write(input: WriteOpenVikingHookManifestInput): Promise<string> {
    const workspaces: HookWorkspace[] = [];
    for (const workspace of input.workspaces) {
      if (!workspace.managed) continue;
      const credentials = await this.options.credentials.get(workspace.id);
      if (!credentials) continue;
      let rootPath: string;
      try {
        rootPath = await this.options.realpath(workspace.rootPath);
      } catch {
        continue;
      }
      workspaces.push({ id: workspace.id, rootPath, ...credentials });
    }

    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const manifest = {
      version: 1,
      baseUrl: input.baseUrl,
      stateDir: path.join(path.dirname(this.filePath), "hook-state"),
      integrations: input.integrations,
      workspaces,
    };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.filePath;
  }
}
