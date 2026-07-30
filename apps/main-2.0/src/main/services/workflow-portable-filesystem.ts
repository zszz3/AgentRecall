import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeWorkflowExportFileAtomically(filePath: string, content: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const temporaryPath = workflowExportTemporaryPath(resolved, randomUUID(), path);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, resolved);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function workflowExportTemporaryPath(filePath: string, nonce: string, pathApi: Pick<typeof path, "dirname" | "basename" | "join">): string {
  return pathApi.join(pathApi.dirname(filePath), `.${pathApi.basename(filePath)}.${nonce}.tmp`);
}
