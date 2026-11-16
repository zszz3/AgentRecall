#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolveNpmInvocation } from "./npm-command.mjs";

const applications = [
  { label: "V1", directory: "apps/main-1.0" },
  { label: "V2", directory: "apps/main-2.0" },
];

function forwardLines(stream, label, destination) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = `${pending}${chunk}`.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) destination.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) destination.write(`[${label}] ${pending}\n`);
  });
}

function runPackageSmoke({ label, directory }) {
  return new Promise((resolve, reject) => {
    const npm = resolveNpmInvocation(["--prefix", directory, "run", "package:smoke"], process.env);
    const child = spawn(npm.command, npm.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      ...(npm.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    forwardLines(child.stdout, label, process.stdout);
    forwardLines(child.stderr, label, process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} package smoke exited with ${code ?? signal ?? "unknown status"}.`));
    });
  });
}

const results = await Promise.allSettled(applications.map(runPackageSmoke));
const failures = results
  .map((result, index) => ({ result, application: applications[index] }))
  .filter(({ result }) => result.status === "rejected");
if (failures.length > 0) {
  for (const { result, application } of failures) {
    process.stderr.write(`${application.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
  }
  process.exitCode = 1;
}
