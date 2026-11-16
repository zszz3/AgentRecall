#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLATFORM_PACKAGES = {
  darwin: {
    arm64: "@embedded-postgres/darwin-arm64",
    x64: "@embedded-postgres/darwin-x64",
  },
  linux: {
    arm: "@embedded-postgres/linux-arm",
    arm64: "@embedded-postgres/linux-arm64",
    ia32: "@embedded-postgres/linux-ia32",
    ppc64: "@embedded-postgres/linux-ppc64",
    x64: "@embedded-postgres/linux-x64",
  },
  win32: {
    arm64: "@embedded-postgres/windows-x64",
    x64: "@embedded-postgres/windows-x64",
  },
};

function expectedRuntimeVersion(packagePath, packageName) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8"));
    return manifest.optionalDependencies?.[packageName]
      || manifest.dependencies?.["embedded-postgres"]
      || "";
  } catch {
    return "";
  }
}

function installError(packagePath, platform, arch, packageName, cause) {
  const version = expectedRuntimeVersion(packagePath, packageName);
  const specification = version ? `${packageName}@${version}` : packageName;
  // Upstream @embedded-postgres/windows-x64 declares cpu: ["x64"], so Windows ARM64 needs --force under Prism emulation.
  const forceFlag = platform === "win32" && arch === "arm64" ? " --force" : "";
  return new Error(
    `AgentRecall V2 安装不完整：${platform}-${arch} 的 PostgreSQL 运行组件 ${packageName} 缺失或损坏。\n` +
      `请运行 npm install -g "${specification}"${forceFlag} --registry=https://registry.npmjs.org/。` +
      "如果 npm 正在安装 AgentRecall，请随后重试原安装命令；否则重新运行 agent-recall-v2。",
    { cause },
  );
}

function assertEmbeddedPostgresRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const packagePath = path.resolve(options.packagePath || path.join(__dirname, ".."));
  const packageName = PLATFORM_PACKAGES[platform]?.[arch];
  if (!packageName) {
    throw new Error(`AgentRecall V2 暂不支持 ${platform}-${arch}。`);
  }

  let entryPath;
  try {
    entryPath = require.resolve(packageName, { paths: [packagePath] });
  } catch (error) {
    throw installError(packagePath, platform, arch, packageName, error);
  }

  if (options.requireSelfContained) {
    const nodeModulesRoot = fs.realpathSync(path.join(packagePath, "node_modules"));
    const relativeEntry = path.relative(nodeModulesRoot, fs.realpathSync(entryPath));
    if (
      relativeEntry === ".."
      || relativeEntry.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeEntry)
    ) {
      throw installError(
        packagePath,
        platform,
        arch,
        packageName,
        new Error("the staged package resolves its runtime outside its own node_modules"),
      );
    }
  }

  const runtimeRoot = path.resolve(path.dirname(entryPath), "..");
  try {
    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
    const expectedVersion = expectedRuntimeVersion(packagePath, packageName);
    if (
      runtimeManifest.name !== packageName
      || (expectedVersion && runtimeManifest.version !== expectedVersion)
    ) {
      throw new Error(`expected ${packageName}@${expectedVersion || "the matching version"}`);
    }
  } catch (error) {
    throw installError(packagePath, platform, arch, packageName, error);
  }
  const executableSuffix = platform === "win32" ? ".exe" : "";
  for (const executable of ["initdb", "pg_ctl", "postgres"]) {
    const executablePath = path.join(runtimeRoot, "native", "bin", `${executable}${executableSuffix}`);
    try {
      if (!fs.statSync(executablePath).isFile()) throw new Error("not a file");
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch (error) {
      throw installError(packagePath, platform, arch, packageName, error);
    }
  }

  return { packageName, entryPath };
}

module.exports = { assertEmbeddedPostgresRuntime };

if (require.main === module) {
  try {
    assertEmbeddedPostgresRuntime();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
