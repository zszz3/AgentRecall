import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const result = await build({
  entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", bundle: true,
  platform: "node", target: "node22", format: "esm", metafile: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some((item) => !item.path.startsWith("node:") && !require("node:module").isBuiltin(item.path))) {
    throw new Error("CLI bundle contains an unbundled runtime dependency.");
  }
}
await fs.copyFile("../../LICENSE", "LICENSE");
const notices = [];
for (const name of ["proper-lockfile", "graceful-fs", "retry", "signal-exit", "zod"]) {
  let directory = path.dirname(require.resolve(name));
  while (true) {
    const pkg = await fs.readFile(path.join(directory, "package.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (pkg && JSON.parse(pkg).name === name) break;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Missing package metadata for ${name}`);
    directory = parent;
  }
  const files = await fs.readdir(directory);
  const license = files.find((file) => /^licen[cs]e(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`Missing license for ${name}`);
  notices.push(`## ${name}\n\n${await fs.readFile(path.join(directory, license), "utf8")}`);
}
await fs.writeFile("THIRD_PARTY_NOTICES.md", `# Bundled dependencies\n\n${notices.join("\n\n")}\n`);
console.log("Built standalone CLI; all third-party runtime dependencies are bundled.");
