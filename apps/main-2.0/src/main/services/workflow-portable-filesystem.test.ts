import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { workflowExportTemporaryPath, writeWorkflowExportFileAtomically } from "./workflow-portable-filesystem";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workflow portable filesystem", () => {
  test("replaces an existing target without leaving temporary files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentrecall-workflow-export-"));
    temporaryRoots.push(root);
    const target = path.join(root, "fixture.agentrecall-workflow.json");
    await fs.writeFile(target, "old", "utf8");

    await writeWorkflowExportFileAtomically(target, "new");

    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(await fs.readdir(root)).toEqual(["fixture.agentrecall-workflow.json"]);
  });

  test("keeps Windows and macOS temporary exports beside the target", () => {
    expect(workflowExportTemporaryPath("C:\\Exports\\Flow.agentrecall-workflow.json", "nonce", path.win32)).toBe("C:\\Exports\\.Flow.agentrecall-workflow.json.nonce.tmp");
    expect(workflowExportTemporaryPath("/Users/test/Exports/Flow.agentrecall-workflow.json", "nonce", path.posix)).toBe("/Users/test/Exports/.Flow.agentrecall-workflow.json.nonce.tmp");
  });
});
