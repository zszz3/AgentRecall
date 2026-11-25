import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Electron troubleshooting and install guide use the unified Latest release URL and runtime checks", async () => {
  const guide = await readFile("docs/troubleshooting-electron-installation.md", "utf8");
  const installGuide = await readFile("Install.md", "utf8");

  assert.match(
    guide,
    /releases\/latest\/download\/agent-recall\.tgz/,
  );
  assert.doesNotMatch(
    guide,
    /releases\/download\/v2-latest\//,
  );
  assert.doesNotMatch(guide, /agent-recall\s*&/);
  assert.match(guide, /ZIP_NAME="electron-v\$\{ELECTRON_VERSION\}-darwin-\$\{ELECTRON_ARCH\}\.zip"/);
  assert.match(guide, /"\$ELECTRON_BINARY" --version/);
  assert.match(
    installGuide,
    /\[macOS Electron 安装故障排除指南\]\(docs\/troubleshooting-electron-installation\.md\)/,
  );
  assert.match(installGuide, /releases\/latest\/download\/agent-recall\.tgz/);
  assert.match(installGuide, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.doesNotMatch(installGuide, /--registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(guide, /--registry=https:\/\/registry\.npmjs\.org\//);
});
