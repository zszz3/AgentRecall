import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceError, hasErrorCode } from "./errors.js";

const execute = promisify(execFile);

export function canonicalGitHubRepository(input: string): string {
  const value = input.trim();
  const scp = /^git@github\.com:([^\s]+)$/i.exec(value);
  let pathname: string;
  if (scp) pathname = scp[1]!;
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw invalidRepository(); }
    if (url.hostname.toLowerCase() !== "github.com" || url.password || url.search || url.hash
      || !["https:", "ssh:"].includes(url.protocol)
      || (url.protocol === "https:" && (url.username || url.port))
      || (url.protocol === "ssh:" && (url.username !== "git" || (url.port && url.port !== "22")))) {
      throw invalidRepository();
    }
    pathname = url.pathname.slice(1);
  }
  const parts = pathname.replace(/\/$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9_.-]+$/i.test(part) || part === "." || part === "..")) {
    throw invalidRepository();
  }
  return `https://github.com/${parts.map((part) => part.toLowerCase()).join("/")}`;
}

function invalidRepository(): WorkspaceError {
  // Never echo a supplied URL: it may contain a token.
  return new WorkspaceError("INVALID_REPOSITORY", "请提供不含密码或 Token 的 GitHub HTTPS 或 git@github.com SSH 仓库地址。");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execute("git", ["-C", cwd, ...args], {
      timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new WorkspaceError("GIT_UNAVAILABLE", "找不到 Git，请安装 Git 并确认它在 PATH 中。");
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes("not a git repository")) {
      throw new WorkspaceError("NOT_A_REPOSITORY", "当前目录不在 Git 仓库中。");
    }
    throw new WorkspaceError("GIT_FAILED", "无法读取 Git 仓库，请检查目录、仓库权限和本地 Git 配置。");
  }
}

export interface RepositoryCheckout {
  root: string;
  gitCommonDir: string;
  remotes: string[];
}

export async function inspectCheckout(directory: string): Promise<RepositoryCheckout | null> {
  const cwd = await fs.realpath(directory);
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_A_REPOSITORY") return null;
    throw error;
  }

  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const names = await git(cwd, ["remote"]);
  return {
    root: await fs.realpath(root),
    gitCommonDir: await fs.realpath(common),
    remotes: names ? names.split(/\r?\n/) : [],
  };
}

export async function checkoutRepository(checkout: RepositoryCheckout, requestedRemote?: string | null): Promise<{
  repository: string | null;
  remote: string | null;
}> {
  if (requestedRemote === null) return { repository: null, remote: null };
  const remote = requestedRemote ?? (checkout.remotes.includes("origin")
    ? "origin" : checkout.remotes.length === 1 ? checkout.remotes[0] : undefined);
  if (!remote) {
    if (checkout.remotes.length > 1) throw new WorkspaceError("AMBIGUOUS_REMOTE", "此仓库有多个 remote，请用 --remote 明确选择。");
    return { repository: null, remote: null };
  }
  if (!checkout.remotes.includes(remote)) throw new WorkspaceError("REMOTE_NOT_FOUND", "找不到所选 remote，请检查 Git 配置或重新绑定项目。");
  return { repository: canonicalGitHubRepository(await git(checkout.root, ["remote", "get-url", remote])), remote };
}

export function sameLocalPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
