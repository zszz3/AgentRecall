import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstructionCatalogService } from "./instruction-catalog-service";

let root = "";
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("InstructionCatalogService", () => {
  it("reads, opens and reveals only files it found, looking again before refusing", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-catalog-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "AGENTS.md"), "repo rules");
    await fs.writeFile(path.join(root, "secret.txt"), "not an instruction file");
    const projects = vi.fn(async () => [repo]);
    const openPath = vi.fn(async () => "");
    const revealPath = vi.fn();
    const service = new InstructionCatalogService({ home: path.join(root, "home"), env: {}, localProjects: projects, openPath, revealPath });

    // Read before the page listed anything: the service looks once and finds the file.
    await expect(service.read(path.join(repo, "AGENTS.md"))).resolves.toBe("repo rules");
    await expect(service.read(path.join(root, "secret.txt"))).rejects.toThrow("not one of the instruction files");
    await service.open(path.join(repo, "AGENTS.md"));
    await service.reveal(path.join(repo, "AGENTS.md"));

    expect(openPath).toHaveBeenCalledWith(path.join(repo, "AGENTS.md"));
    expect(revealPath).toHaveBeenCalledWith(path.join(repo, "AGENTS.md"));
    expect((await service.list()).map((file) => file.name)).toEqual(["AGENTS.md"]);

    openPath.mockResolvedValueOnce("No application knows how to open this file");
    await expect(service.open(path.join(repo, "AGENTS.md"))).rejects.toThrow("Could not open AGENTS.md: No application knows how to open this file");
  });
});
