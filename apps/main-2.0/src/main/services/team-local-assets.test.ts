import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readTeamLocalAssets } from "./team-local-assets";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "team-local-assets-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("discovers local documents and client Skills even without a team manifest, without changing files", async () => {
  await fs.mkdir(path.join(root, "docs", "design"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "本地约定");
  await fs.writeFile(path.join(root, "docs", "design", "overview.md"), "设计说明");
  for (const location of [".agents", ".claude", ".codex"]) {
    await fs.mkdir(path.join(root, location, "skills", "review"), { recursive: true });
    await fs.writeFile(path.join(root, location, "skills", "review", "SKILL.md"), "本地技能");
  }
  const docs = await readTeamLocalAssets(root, "documents"), skills = await readTeamLocalAssets(root, "skills");
  expect("entries" in docs && docs.entries.map((entry) => entry.path)).toEqual(["AGENTS.md", "docs/design/overview.md"]);
  expect("entries" in skills && skills.entries).toHaveLength(3);
  expect(await readTeamLocalAssets(root, "skills", ".agents/skills/review/SKILL.md")).toEqual({ path: ".agents/skills/review/SKILL.md", content: "本地技能" });
  expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("本地约定");
  expect(await fs.readdir(root)).not.toContain("agentrecall.json");
});
it("rejects arbitrary paths, outside links and cancelled scans", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "team-outside-"));
  try {
    await fs.writeFile(path.join(outside, "secret.md"), "must not read");
    await fs.symlink(outside, path.join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
    expect(await readTeamLocalAssets(root, "documents")).toMatchObject({ entries: [] });
    await expect(readTeamLocalAssets(root, "documents", "../secret.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_NOT_FOUND" });
    await expect(readTeamLocalAssets(root, "documents", "docs/secret.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_NOT_FOUND" });
    const abort = new AbortController(); abort.abort();
    await expect(readTeamLocalAssets(root, "skills", undefined, abort.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});
it("bounds previews including multibyte bytes and JSON escaping, with no truncation", async () => {
  const file = path.join(root, "README.md");
  await fs.writeFile(file, ""); expect(await readTeamLocalAssets(root, "documents", "README.md")).toMatchObject({ content: "" });
  const exact = "汉".repeat(174762) + "aa";
  await fs.writeFile(file, exact); expect(Buffer.byteLength(exact)).toBe(512 * 1024);
  expect(await readTeamLocalAssets(root, "documents", "README.md")).toMatchObject({ content: exact });
  await fs.appendFile(file, "a"); await expect(readTeamLocalAssets(root, "documents", "README.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_TOO_LARGE" });
  await fs.writeFile(file, "\u0001".repeat(200_000)); await expect(readTeamLocalAssets(root, "documents", "README.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_TOO_LARGE" });
  await fs.writeFile(file, Buffer.from([255])); await expect(readTeamLocalAssets(root, "documents", "README.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_INVALID" });
});
it("reports partial listings instead of claiming a bounded scan is complete", async () => {
  await fs.mkdir(path.join(root, "docs"));
  await Promise.all(Array.from({ length: 260 }, (_, index) => fs.writeFile(path.join(root, "docs", `${index}.md`), "x")));
  const result = await readTeamLocalAssets(root, "documents");
  expect("entries" in result && result.entries.length).toBe(256);
  expect(result).toMatchObject({ limited: true });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
});

it("captures the selected Skill's complete files, ignores its install marker and refuses links or environment files", async () => {
  const { readTeamLocalPush } = await import("./team-local-assets");
  const directory = path.join(root, ".agents", "skills", "review"); await fs.mkdir(path.join(directory, "scripts"), { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
  await fs.writeFile(path.join(directory, "scripts", "check.sh"), "exit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(directory, "icon.bin"), Buffer.from([0, 255, 2]));
  await fs.writeFile(path.join(directory, ".agentrecall-install.json"), "private local installation metadata");
  const captured = await readTeamLocalPush(root, "skills", ".agents/skills/review/SKILL.md");
  expect(captured.files?.map(file => file.path)).toEqual(["icon.bin", "scripts/check.sh", "SKILL.md"]);
  expect(Buffer.from(captured.files![0]!.content, "base64")).toEqual(Buffer.from([0, 255, 2]));
  if (process.platform !== "win32") expect(captured.files?.find(file => file.path === "scripts/check.sh")?.executable).toBe(true);
  await fs.writeFile(path.join(directory, ".env"), "PRIVATE_VALUE=fixture");
  await expect(readTeamLocalPush(root, "skills", ".agents/skills/review/SKILL.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_INVALID" });
  await expect(readTeamLocalPush(root, "documents", "../private.md")).rejects.toMatchObject({ code: "LOCAL_ASSET_NOT_FOUND" });
});

it("reads a selected document without rescanning other resources", async () => {
  const { readTeamLocalPush } = await import("./team-local-assets");
  await fs.mkdir(path.join(root, "docs")); await fs.writeFile(path.join(root, "docs", "one.md"), "Selected document");
  const { vi } = await import("vitest");
  const scan = vi.spyOn(fs, "opendir").mockRejectedValue(new Error("No directory scan expected"));
  try { expect(await readTeamLocalPush(root, "documents", "docs/one.md")).toMatchObject({ content: "Selected document" }); expect(scan).not.toHaveBeenCalled(); }
  finally { scan.mockRestore(); }
});
