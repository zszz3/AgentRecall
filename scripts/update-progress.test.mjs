import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createTerminalUpdateProgress } = require("../bin/update-progress.cjs");

function outputStream(isTTY) {
  let output = "";
  return {
    isTTY,
    columns: 100,
    write(chunk) {
      output += String(chunk);
      return true;
    },
    output: () => output,
  };
}

function fakeClock() {
  let now = 0;
  let interval = null;
  return {
    now: () => now,
    setInterval(callback) {
      interval = callback;
      return callback;
    },
    clearInterval(callback) {
      if (interval === callback) interval = null;
    },
    advance(milliseconds) {
      now += milliseconds;
      interval?.();
    },
    active: () => interval !== null,
  };
}

test("renders real download progress and simulated npm progress in a TTY", () => {
  const stream = outputStream(true);
  const clock = fakeClock();
  const progress = createTerminalUpdateProgress({ stream, timers: clock, now: clock.now });

  progress.report({
    phase: "downloading",
    version: "0.32.0",
    percent: 25,
    downloadedBytes: 2 * 1024 * 1024,
    totalBytes: 8 * 1024 * 1024,
    bytesPerSecond: 1024 * 1024,
  });
  progress.report({ phase: "staging", version: "0.32.0" });
  clock.advance(10 * 60_000);

  assert.match(stream.output(), /25%/);
  assert.match(stream.output(), /1\.0 MB\/s/);
  assert.match(stream.output(), /正在通过 npm 安装/);
  assert.match(stream.output(), /90%/);
  assert.equal(clock.active(), true);

  progress.report({ phase: "validating", version: "0.32.0" });
  assert.equal(clock.active(), false);
  progress.complete("0.32.0");
  assert.match(stream.output(), /100%/);
  assert.match(stream.output(), /v0\.32\.0/);
});

test("prints phase changes without cursor control sequences outside a TTY", () => {
  const stream = outputStream(false);
  const clock = fakeClock();
  const progress = createTerminalUpdateProgress({ stream, timers: clock, now: clock.now });

  progress.report({ phase: "downloading", version: "0.32.0", percent: 10 });
  progress.report({ phase: "downloading", version: "0.32.0", percent: 20 });
  progress.report({ phase: "staging", version: "0.32.0" });
  clock.advance(30_000);
  progress.report({ phase: "validating", version: "0.32.0" });
  progress.complete("0.32.0");

  assert.doesNotMatch(stream.output(), /\r|\u001b/);
  assert.equal(stream.output().match(/正在下载更新/g)?.length, 1);
  assert.equal(stream.output().match(/正在通过 npm 安装/g)?.length, 1);
  assert.equal(stream.output().match(/正在验证应用/g)?.length, 1);
  assert.match(stream.output(), /更新完成/);
});

test("dispose stops simulated npm progress without printing completion", () => {
  const stream = outputStream(true);
  const clock = fakeClock();
  const progress = createTerminalUpdateProgress({ stream, timers: clock, now: clock.now });

  progress.report({ phase: "staging", version: "0.32.0" });
  progress.dispose();

  assert.equal(clock.active(), false);
  assert.doesNotMatch(stream.output(), /100%/);
});
