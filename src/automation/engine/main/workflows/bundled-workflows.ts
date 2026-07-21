import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkflowV2Definition, WorkflowV2LLMNode } from "../../shared/workflow-v2/definition";

export interface BundledWorkflowDefinition {
  workflowId: string;
  title: string;
  objective: string;
  definition: WorkflowV2Definition;
}

/**
 * Load workflow definitions bundled with the app (git-tracked assets under
 * src/shared/bundled-workflows, copied to out/shared/bundled-workflows at build).
 * Each subdirectory has a workflow.json. Asset files referenced via an `assets`
 * map (token -> filename) — or the legacy `templateAsset` -> `__RESUME_TEMPLATE__`
 * — are read and injected into node prompts wherever the token appears.
 */
export async function loadBundledWorkflows(rootDir: string): Promise<BundledWorkflowDefinition[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const definitions: BundledWorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "workflow.json"), "utf8")) as {
        id?: unknown;
        title?: unknown;
        objective?: unknown;
        templateAsset?: unknown;
        assets?: Record<string, unknown>;
        definition?: WorkflowV2Definition;
      };
      const workflowId = typeof manifest.id === "string" ? manifest.id : "";
      const definition = manifest.definition;
      if (!workflowId || !definition || !Array.isArray(definition.nodes)) continue;

      const assetTokens: Record<string, string> = {};
      if (typeof manifest.templateAsset === "string" && manifest.templateAsset) assetTokens.__RESUME_TEMPLATE__ = manifest.templateAsset;
      if (manifest.assets && typeof manifest.assets === "object") {
        for (const [token, file] of Object.entries(manifest.assets)) {
          if (typeof file === "string" && file) assetTokens[token] = file;
        }
      }
      for (const [token, file] of Object.entries(assetTokens)) {
        let content = "";
        try {
          content = (await readFile(path.join(dir, file), "utf8")).trimEnd();
        } catch {
          content = "";
        }
        if (!content) continue;
        for (const node of definition.nodes) {
          if (node.execModel === "llm" && node.prompt.includes(token)) {
            node.prompt = node.prompt.split(token).join(content);
          }
        }
      }

      definitions.push({
        workflowId,
        title: typeof manifest.title === "string" && manifest.title ? manifest.title : definition.objective,
        objective: typeof manifest.objective === "string" && manifest.objective ? manifest.objective : definition.objective,
        definition: { ...definition, workflowId, objective: typeof manifest.objective === "string" && manifest.objective ? manifest.objective : definition.objective },
      });
    } catch {
      // Skip malformed bundled workflow directories.
    }
  }
  return definitions;
}
