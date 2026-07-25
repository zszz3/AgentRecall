import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeBuildRoot = path.join(root, "dist");
const stage = path.join(nativeBuildRoot, "native-app");

const relativeStage = path.relative(nativeBuildRoot, stage);
if (!relativeStage || relativeStage.startsWith("..") || path.isAbsolute(relativeStage)) {
  throw new Error("Native application staging path escaped the native build directory.");
}

const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const { electron: _electron, ...runtimeDependencies } = sourcePackage.dependencies ?? {};
if (!_electron) throw new Error("The root package must declare the Electron runtime used by the npm fallback.");

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await Promise.all([
  cp(path.join(root, "out"), path.join(stage, "out"), { recursive: true }),
  cp(path.join(root, "assets"), path.join(stage, "assets"), { recursive: true }),
]);

const nativePackage = {
  name: sourcePackage.name,
  productName: sourcePackage.productName,
  version: sourcePackage.version,
  description: sourcePackage.description,
  author: sourcePackage.author ?? "AgentRecall contributors",
  license: sourcePackage.license,
  main: sourcePackage.main,
  type: sourcePackage.type,
  dependencies: runtimeDependencies,
};
await writeFile(
  path.join(stage, "package.json"),
  `${JSON.stringify(nativePackage, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Prepared native application staging for v${nativePackage.version}.\n`);
