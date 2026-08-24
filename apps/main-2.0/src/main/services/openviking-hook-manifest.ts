import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpenVikingWorkspace } from "../../core/openviking-memory";
import type { OpenVikingMemoryControl } from "../../core/openviking-memory-control";
import type { OpenVikingWorkspaceAuth } from "./openviking-client";
import type { OpenVikingCredentialStorePort } from "./openviking-memory-service";

interface OpenVikingHookManifestServiceOptions {
  rootDir: string;
  credentials: Pick<OpenVikingCredentialStorePort, "get">;
  control: {
    listOpenVikingMemoryControls(workspaceId: string): Promise<OpenVikingMemoryControl[]>;
  };
  realpath(value: string): Promise<string>;
}

interface WriteOpenVikingHookManifestInput {
  baseUrl: string | null;
  // Diagnostic only: hooks cannot call the control plane without a baseUrl, but
  // recording why it is missing separates "memory is off" from "the runtime is
  // still installing or failed to start".
  runtimeState?: string;
  integrations: {
    claude: boolean;
    codex: boolean;
    opencode: boolean;
  };
  workspaces: OpenVikingWorkspace[];
  recallTokenBudget: number;
}

interface HookWorkspace extends OpenVikingWorkspaceAuth {
  id: string;
  rootPath: string;
  policyPath: string;
  recallTokenBudget: number;
}

export class OpenVikingHookManifestService {
  private readonly filePath: string;

  constructor(private readonly options: OpenVikingHookManifestServiceOptions) {
    this.filePath = path.join(path.resolve(options.rootDir), "hook-manifest.json");
  }

  manifestPath(): string {
    return this.filePath;
  }

  stateDir(): string {
    return path.join(path.dirname(this.filePath), "hook-state");
  }

  async clear(): Promise<void> {
    await Promise.all([
      rm(this.filePath, { force: true }),
      rm(this.policyDir(), { recursive: true, force: true }),
    ]);
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
      const policyPath = path.join(this.policyDir(), `${workspace.id}.json`);
      const controls = await this.options.control.listOpenVikingMemoryControls(workspace.id);
      await writeJsonAtomic(policyPath, {
        version: 2,
        strict: true,
        workspaceId: workspace.id,
        memories: Object.fromEntries(controls.map((control) => [control.uri, {
          memoryType: control.memoryType,
          authority: control.authority,
          lifecycle: control.lifecycle,
          locked: control.locked,
          evidenceStatus: control.evidenceStatus,
          evidenceCount: control.evidenceCount,
          updatedAt: control.updatedAt,
          ...(control.title ? { title: control.title } : {}),
          ...(control.locked && control.lockedContent !== undefined
            ? { lockedContent: control.lockedContent }
            : {}),
        }])),
      });
      workspaces.push({
        id: workspace.id,
        rootPath,
        policyPath,
        recallTokenBudget: input.recallTokenBudget,
        ...credentials,
      });
    }

    await this.removeStalePolicies(new Set(workspaces.map((workspace) => workspace.id)));
    const manifest = {
      version: 2,
      baseUrl: input.baseUrl,
      ...(input.runtimeState ? { runtimeState: input.runtimeState } : {}),
      stateDir: this.stateDir(),
      integrations: input.integrations,
      workspaces,
    };
    await writeJsonAtomic(this.filePath, manifest);
    return this.filePath;
  }

  private policyDir(): string {
    return path.join(path.dirname(this.filePath), "memory-policies");
  }

  private async removeStalePolicies(activeWorkspaceIds: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.policyDir());
    } catch {
      return;
    }
    await Promise.all(names
      .filter((name) => name.endsWith(".json") && !activeWorkspaceIds.has(name.slice(0, -5)))
      .map((name) => rm(path.join(this.policyDir(), name), { force: true })));
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
