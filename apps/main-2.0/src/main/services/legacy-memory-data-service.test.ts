import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyMemoryDataService } from "./legacy-memory-data-service";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-legacy-memory-"));
  roots.push(root);
  const dataDir = path.join(root, "userData", "openviking");
  const pointerPath = path.join(root, "home", ".agent-recall-v2", "openviking-manifest-path");
  return { root, dataDir, pointerPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LegacyMemoryDataService", () => {
  it("reports nothing to delete when the legacy directory is absent", async () => {
    const { dataDir, pointerPath } = fixture();
    const service = new LegacyMemoryDataService({ dataDir, pointerPath });

    await expect(service.status()).resolves.toEqual({ present: false, sizeBytes: 0 });
  });

  it("measures nested files without following symbolic links", async () => {
    const { root, dataDir, pointerPath } = fixture();
    fs.mkdirSync(path.join(dataDir, "runtime", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "runtime", "lib", "a.bin"), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dataDir, "hook-manifest.json"), Buffer.alloc(24));
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "large.bin"), Buffer.alloc(50_000));
    if (process.platform !== "win32") fs.symlinkSync(outside, path.join(dataDir, "linked"));

    const status = await new LegacyMemoryDataService({ dataDir, pointerPath }).status();

    expect(status.present).toBe(true);
    expect(status.sizeBytes).toBeGreaterThanOrEqual(1024);
    expect(status.sizeBytes).toBeLessThan(50_000);
  });

  it("deletes the directory and its pointer but leaves link targets intact", async () => {
    const { root, dataDir, pointerPath } = fixture();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "memory.db"), "data");
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, `${path.join(dataDir, "hook-manifest.json")}\n`);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    if (process.platform !== "win32") fs.symlinkSync(outside, path.join(dataDir, "linked"));
    const service = new LegacyMemoryDataService({ dataDir, pointerPath });

    await expect(service.remove()).resolves.toEqual({ present: false, sizeBytes: 0 });

    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("shares one deletion between overlapping requests and allows a retry after failure", async () => {
    const { dataDir, pointerPath } = fixture();
    fs.mkdirSync(dataDir, { recursive: true });
    let calls = 0;
    let failNext = true;
    const service = new LegacyMemoryDataService({
      dataDir,
      pointerPath,
      removeDirectory: async (target) => {
        calls += 1;
        if (failNext) {
          failNext = false;
          throw new Error("EBUSY: resource busy");
        }
        await fs.promises.rm(target, { recursive: true, force: true });
      },
    });

    const first = service.remove();
    const second = service.remove();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("EBUSY");
    expect(calls).toBe(1);
    expect(fs.existsSync(dataDir)).toBe(true);

    await expect(service.remove()).resolves.toEqual({ present: false, sizeBytes: 0 });
    expect(calls).toBe(2);
  });
});
