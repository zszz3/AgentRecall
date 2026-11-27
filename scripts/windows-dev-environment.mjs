import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOW_INTEGRITY_SID = "S-1-16-4096";
const HIGH_INTEGRITY_SIDS = ["S-1-16-12288", "S-1-16-16384"];
// icacls prints well-known label names rather than SIDs, so match the name and the SID form.
const LOW_LABEL_PATTERN = /Low Mandatory Level|S-1-16-4096/i;

/**
 * Turns Windows facts that are known to break a source checkout into actionable messages.
 * Each problem keeps Electron, esbuild or the embedded PostgreSQL server from starting,
 * and none of them can be repaired from inside the process that detects it.
 */
export function windowsDevEnvironmentProblems({ groupsCsv, workspaceAcl, workspaceRoot, requireUnelevated, env }) {
  const problems = [];
  if (groupsCsv.includes(LOW_INTEGRITY_SID)) {
    problems.push(
      "当前终端以低完整性级别运行（通常由沙箱或受限启动器打开）。Electron、esbuild 和内置 PostgreSQL 都无法在此级别写入用户目录。"
        + "请从开始菜单打开一个普通终端后重试。",
    );
  }
  if (LOW_LABEL_PATTERN.test(workspaceAcl)) {
    problems.push(
      `项目目录带有低完整性标记，从该目录启动的 Electron、esbuild 会被降为低完整性进程而崩溃或报 Access is denied。`
        + `在普通终端执行以下命令后重试：\n  icacls "${workspaceRoot}" /setintegritylevel "(OI)(CI)medium"`,
    );
  }
  if (requireUnelevated && !env.AGENT_RECALL_DATABASE_URL && HIGH_INTEGRITY_SIDS.some((sid) => groupsCsv.includes(sid))) {
    problems.push(
      "当前终端以管理员身份运行，内置 PostgreSQL 拒绝在管理员权限下启动。请在不以管理员身份运行的普通终端中执行 npm run dev，"
        + "或通过 AGENT_RECALL_DATABASE_URL 指定外部数据库。",
    );
  }
  return problems;
}

async function readCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true, encoding: "utf8" });
  return stdout;
}

export async function assertWindowsDevEnvironment(workspaceRoot, { requireUnelevated }) {
  if (process.platform !== "win32") return;
  const [groupsCsv, workspaceAcl] = await Promise.all([
    readCommand("whoami.exe", ["/groups", "/fo", "csv"]),
    readCommand("icacls.exe", [workspaceRoot]),
  ]);
  const problems = windowsDevEnvironmentProblems({
    groupsCsv,
    workspaceAcl,
    workspaceRoot,
    requireUnelevated,
    env: process.env,
  });
  if (problems.length > 0) {
    throw new Error(`Windows 开发环境检查未通过：\n- ${problems.join("\n- ")}`);
  }
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  assertWindowsDevEnvironment(repositoryRoot, { requireUnelevated: true }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
