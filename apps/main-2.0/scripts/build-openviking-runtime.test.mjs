import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSafeBuildDirectory,
  assertTrustedPythonArchiveUrl,
  buildRuntimeArtifactFromUrl,
  buildRuntimePlan,
  createRuntimeArchive,
  patchCodexResponsesAdapter,
  patchVlmReasoningEffortConfig,
  runtimeArchiveRoot,
  runtimeArtifactName,
} from "./build-openviking-runtime.mjs";

test("runtime patch forwards configured reasoning effort to Codex Responses", () => {
  const source = [
    "        response_kwargs: Dict[str, Any] = {",
    '            "model": model,',
    "        }",
    '        tools = _convert_tools_for_responses(kwargs.get("tools"))',
    "        if tools:",
    '            response_kwargs["tools"] = tools',
    "        stream = client.responses.create(**response_kwargs, stream=True)",
    "",
  ].join("\n");

  const patched = patchCodexResponsesAdapter(source);

  assert.match(patched, /reasoning_effort = kwargs\.get\("reasoning_effort"\)/u);
  assert.match(patched, /response_kwargs\["reasoning"\] = \{"effort": reasoning_effort\}/u);
  assert.throws(
    () => patchCodexResponsesAdapter("unexpected source"),
    /unsupported OpenViking Codex adapter/u,
  );
});

test("runtime patch accepts and forwards configured VLM reasoning effort", () => {
  const source = [
    "    thinking: bool = Field(default=False, description=\"Enable thinking mode\")",
    "",
    "    def _build_vlm_config_dict_for_credential(self, credential):",
    "        result = {",
    '            "thinking": self.thinking,',
    "        }",
    "",
    "    def _build_vlm_config_dict(self):",
    "        result = {",
    '            "thinking": self.thinking,',
    "        }",
    "",
  ].join("\n");

  const patched = patchVlmReasoningEffortConfig(source);

  assert.match(patched, /reasoning_effort: str = Field\(default="low"/u);
  assert.equal(
    patched.match(/"reasoning_effort": self\.reasoning_effort/g)?.length,
    2,
  );
  assert.throws(
    () => patchVlmReasoningEffortConfig("unexpected source"),
    /unsupported OpenViking VLM config/u,
  );
});

test("runtime packaging reports real archive bytes and generation speed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-packaging-progress-"));
  const sourceDir = path.join(root, "source");
  const outputPath = path.join(root, "runtime.tar.gz");
  const progress = [];
  try {
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, "fixture.bin"), randomBytes(8 * 1024 * 1024));

    await createRuntimeArchive({
      sourceDir,
      outputPath,
      progressIntervalMs: 1,
      onProgress: (event) => progress.push(event),
    });

    assert.deepEqual(progress[0], {
      phase: "packaging-runtime",
      downloadedBytes: 0,
    });
    assert.equal(progress.at(-1).downloadedBytes, (await stat(outputPath)).size);
    assert.ok(progress.every((event, index) =>
      index === 0 || event.downloadedBytes >= progress[index - 1].downloadedBytes));
    assert.ok(progress.some((event) => event.bytesPerSecond > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime artifact names pin OpenViking and target platform", () => {
  assert.equal(
    runtimeArtifactName({ version: "0.4.11", platform: "darwin", arch: "arm64" }),
    "openviking-runtime-0.4.11-darwin-arm64.tar.gz",
  );
});

test("runtime build revisions keep the upstream OpenViking package version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-revision-"));
  try {
    const plan = buildRuntimePlan({
      version: "0.4.11-r4",
      platform: "darwin",
      arch: "arm64",
      buildHome: path.join(root, "home"),
      outputDir: path.join(root, "output"),
      pythonArchive: path.join(root, "cpython.tar.gz"),
      pythonSha256: "a".repeat(64),
    });

    assert.equal(
      plan.outputPath,
      path.join(root, "output", "openviking-runtime-0.4.11-r4-darwin-arm64.tar.gz"),
    );
    assert.ok(plan.pipArgs.includes("openviking[local-embed]==0.4.11"));
    assert.ok(!plan.pipArgs.includes("openviking[local-embed]==0.4.11-r4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime builds require explicit isolated HOME and output directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-build-"));
  try {
    const buildHome = path.join(root, "home");
    const outputDir = path.join(root, "output");
    const plan = buildRuntimePlan({
      version: "0.4.11",
      platform: "darwin",
      arch: "arm64",
      buildHome,
      outputDir,
      pythonArchive: path.join(root, "cpython.tar.gz"),
      pythonSha256: "a".repeat(64),
    });

    assert.equal(plan.env.HOME, buildHome);
    assert.equal(plan.env.PIP_CACHE_DIR, path.join(buildHome, ".cache", "pip"));
    assert.equal(plan.outputPath, path.join(outputDir, "openviking-runtime-0.4.11-darwin-arm64.tar.gz"));
    assert.equal(plan.pythonSha256, "a".repeat(64));
    assert.deepEqual(plan.pipArgs, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "openviking[local-embed]==0.4.11",
      "mcp>=1.27.0,<2",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows runtime builds use the pinned prebuilt llama.cpp wheel", () => {
  const root = path.join(tmpdir(), "agent-recall-runtime-windows-plan");
  const plan = buildRuntimePlan({
    version: "0.4.11",
    platform: "win32",
    arch: "x64",
    buildHome: path.join(root, "home"),
    outputDir: path.join(root, "output"),
    pythonArchive: path.join(root, "cpython.tar.gz"),
    pythonSha256: "a".repeat(64),
  });

  assert.deepEqual(plan.pipArgs, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    [
      "llama-cpp-python @ ",
      "https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.34/",
      "llama_cpp_python-0.3.34-py3-none-win_amd64.whl",
      "#sha256=6526fff614e5ef7e439e6369e076a78073e45e1d791dbe1d5e5d42661f46ca1a",
    ].join(""),
    "openviking[local-embed]==0.4.11",
    "mcp>=1.27.0,<2",
  ]);
});

test("runtime build rejects an invalid standalone Python checksum", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-checksum-"));
  try {
    assert.throws(() => buildRuntimePlan({
      version: "0.4.11",
      platform: "darwin",
      arch: "arm64",
      buildHome: path.join(root, "home"),
      outputDir: path.join(root, "output"),
      pythonArchive: path.join(root, "cpython.tar.gz"),
      pythonSha256: "unchecked",
    }), /checksum is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime build refuses broad or unresolved output paths", () => {
  for (const unsafe of ["/", homedir(), process.cwd(), ".", ""]) {
    assert.throws(
      () => assertSafeBuildDirectory(unsafe, "output"),
      /safe explicit output directory/,
    );
  }
});

test("runtime archive root contains bin on macOS and Scripts on Windows", () => {
  assert.equal(runtimeArchiveRoot("/stage/python/bin/python3", "darwin"), "/stage/python");
  assert.equal(
    runtimeArchiveRoot("C:\\stage\\python\\python.exe", "win32", path.win32),
    "C:\\stage\\python",
  );
});

test("runtime build downloads standalone Python only from the pinned upstream release", () => {
  assert.equal(
    assertTrustedPythonArchiveUrl("https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython.tar.gz").hostname,
    "github.com",
  );
  assert.throws(
    () => assertTrustedPythonArchiveUrl("https://downloads.example/cpython.tar.gz"),
    /trusted python-build-standalone release/,
  );
});

test("runtime build reports exact standalone Python download bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-runtime-progress-"));
  const originalFetch = globalThis.fetch;
  const body = Buffer.from("not-a-python-archive");
  const progress = [];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(body);
        controller.close();
      }, 300);
    },
  }), {
    headers: { "content-length": String(body.byteLength) },
  });
  try {
    await assert.rejects(buildRuntimeArtifactFromUrl({
      version: "0.4.11",
      platform: "darwin",
      arch: "arm64",
      buildHome: path.join(root, "home"),
      outputDir: path.join(root, "output"),
      pythonUrl: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython.tar.gz",
      pythonSha256: createHash("sha256").update(body).digest("hex"),
      onProgress: (event) => progress.push(event),
    }));
    assert.deepEqual(progress[0], {
      phase: "downloading-python",
      downloadedBytes: 0,
      totalBytes: body.byteLength,
    });
    const completedDownload = progress.findLast((event) =>
      event.phase === "downloading-python" && event.downloadedBytes === body.byteLength);
    assert.equal(completedDownload.totalBytes, body.byteLength);
    assert.ok(completedDownload.bytesPerSecond > 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
