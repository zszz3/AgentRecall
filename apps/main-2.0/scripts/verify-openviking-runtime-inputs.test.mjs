import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";

import { verifyOpenVikingRuntimeInputs } from "./verify-openviking-runtime-inputs.mjs";

function createZip(files) {
  const entryCount = Object.keys(files).length;
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;
  for (const [filename, source] of Object.entries(files)) {
    const name = Buffer.from(filename);
    const content = Buffer.from(source);
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(localOffset, 42);
    directoryParts.push(directory, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function fakeFetch({ archive, wheel, metadataSha256 = wheel.sha256 }) {
  return async (input, init = {}) => {
    if (String(input).includes("/pypi/")) {
      return Response.json({
        urls: [{
          filename: wheel.filename,
          packagetype: "bdist_wheel",
          digests: { sha256: metadataSha256 },
          size: archive.length,
          url: `https://files.pythonhosted.org/packages/test/${wheel.filename}`,
        }],
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/u.exec(init.headers?.range);
    assert.ok(match, "wheel reads must use HTTP byte ranges");
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(archive.subarray(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${archive.length}` },
    });
  };
}

test("preflights the actual patch surfaces from a platform wheel", async () => {
  const newline = "\r\n";
  const archive = createZip({
    "openviking/llm/codex_responses_adapter.py": [
      "        response_kwargs = {}",
      '        tools = _convert_tools_for_responses(kwargs.get("tools"))',
      "",
    ].join(newline),
    "openviking_cli/utils/config/vlm_config.py": [
      '    thinking: bool = Field(default=False, description="Enable thinking mode")',
      "",
      '            "thinking": self.thinking,',
      '            "thinking": self.thinking,',
      "",
    ].join(newline),
  });
  const wheel = {
    platform: "win32",
    arch: "x64",
    filename: "openviking-test-win_amd64.whl",
    sha256: "a".repeat(64),
    size: archive.length,
  };

  const result = await verifyOpenVikingRuntimeInputs({
    fetchImpl: fakeFetch({ archive, wheel }),
    metadataUrl: "https://pypi.test/pypi/openviking/test/json",
    wheels: [wheel],
  });

  assert.deepEqual(result, [{
    platform: "win32",
    arch: "x64",
    newlineStyles: { codex: "crlf", vlm: "crlf" },
  }]);
});

test("rejects a published wheel that no longer matches the pinned release input", async () => {
  const archive = createZip({});
  const wheel = {
    platform: "win32",
    arch: "x64",
    filename: "openviking-test-win_amd64.whl",
    sha256: "a".repeat(64),
    size: archive.length,
  };
  await assert.rejects(
    verifyOpenVikingRuntimeInputs({
      fetchImpl: fakeFetch({ archive, wheel, metadataSha256: "b".repeat(64) }),
      metadataUrl: "https://pypi.test/pypi/openviking/test/json",
      wheels: [wheel],
    }),
    /wheel metadata changed/u,
  );
});
