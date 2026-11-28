import assert from "node:assert/strict";
import test from "node:test";
import { windowsDevEnvironmentProblems } from "./windows-dev-environment.mjs";

const mediumGroups = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""';
const highGroups = '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""';
const lowGroups = '"Mandatory Label\\Low Mandatory Level","Label","S-1-16-4096",""';
const mediumAcl = "C:\\repo BUILTIN\\Administrators:(I)(OI)(CI)(F)\n Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)";
const lowAcl = "C:\\repo BUILTIN\\Administrators:(I)(OI)(CI)(F)\n Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)";

function problems(overrides) {
  return windowsDevEnvironmentProblems({
    groupsCsv: mediumGroups,
    workspaceAcl: mediumAcl,
    workspaceRoot: "C:\\repo",
    ...overrides,
  });
}

test("accepts a normal or elevated terminal and an unlabelled checkout", () => {
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems({ groupsCsv: highGroups }), []);
});

test("explains how to remove a low integrity label from the checkout", () => {
  const [message] = problems({ workspaceAcl: lowAcl });
  assert.match(message, /icacls "C:\\repo" \/setintegritylevel "\(OI\)\(CI\)medium"/);
});

test("rejects a low integrity terminal", () => {
  assert.equal(problems({ groupsCsv: lowGroups }).length, 1);
});
