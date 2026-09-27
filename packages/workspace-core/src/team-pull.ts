import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceService } from "./workspace.js";
import type { AssetSnapshot } from "./asset-format.js";
import type { DirectoryConnection, TeamSpace } from "./config.js";
import { withAssetLock } from "./asset-storage.js";
import { inspectProjectSkill, markedProjectSkills, prepareSkillInstall, uninstallProjectSkill } from "./project-skills.js";
import { ProjectDocuments } from "./project-documents.js";
import { ProjectWorkConfigs } from "./project-work-configs.js";

const itemSchema = z.object({ kind: z.enum(["skill", "document", "directory"]), id: z.string().max(200), target: z.enum(["codex", "claude"]).optional(), status: z.enum(["installed", "updated", "unchanged", "retired", "conflict", "failed"]), message: z.string().max(500).optional(), backup: z.string().max(512).optional() }).strict();
const pullReportSchema = z.object({ schemaVersion: z.literal(1), repository: z.string().max(2048), commit: z.string().regex(/^[a-f0-9]{40}$/), startedAt: z.number(), finishedAt: z.number(), status: z.enum(["complete", "partial", "cancelled", "no-directories"]), directories: z.array(z.object({ id: z.string().max(64), path: z.string().max(32768), status: z.enum(["complete", "partial", "skipped", "cancelled"]), items: z.array(itemSchema).max(512) }).strict()).max(32) }).strict();
export type TeamPullReport = z.infer<typeof pullReportSchema>;
export const MAX_PULL_REPORT_BYTES = 16 * 1024 * 1024;
export function validatePullReport(value: unknown): TeamPullReport {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PULL_REPORT_BYTES) throw new WorkspaceError("PULL_REPORT_TOO_LARGE", "同步结果超过大小限制，文件操作可能已完成，请检查各目录及备份后重试。");
  return pullReportSchema.parse(value);
}


export async function distributeTeamAssets(workspace: WorkspaceService, team: TeamSpace, connections: DirectoryConnection[], snapshot: AssetSnapshot, signal?: AbortSignal): Promise<TeamPullReport> {
  const report: TeamPullReport = { schemaVersion: 1, repository: team.repository, commit: snapshot.commit, startedAt: Date.now(), finishedAt: Date.now(), status: connections.some((entry) => entry.enabled) ? "complete" : "no-directories", directories: [] };
  const cancelled = () => { if (signal?.aborted) throw new WorkspaceError("CANCELLED", "同步已取消，已完成的文件和备份保留。"); };
  for (const connection of connections) {
    const result: TeamPullReport["directories"][number] = { id: connection.id, path: connection.path, status: !connection.enabled ? "skipped" : signal?.aborted ? "cancelled" : "complete", items: [] };
    report.directories.push(result);
    if (result.status === "skipped") continue;
    if (signal?.aborted) { report.status = "cancelled"; continue; }
    const issue = (kind: "skill" | "document" | "directory", id: string, error: unknown, target?: "codex" | "claude") => {
      if (error instanceof WorkspaceError && error.code === "CANCELLED") { result.status = "cancelled"; report.status = "cancelled"; return; }
      result.status = "partial"; if (report.status !== "cancelled") report.status = "partial";
      const previous = result.items.find((item) => item.kind === kind && item.id === id && item.target === target);
      const failure: TeamPullReport["directories"][number]["items"][number] = { kind, id, ...(target ? { target } : {}), status: error instanceof WorkspaceError && /CONFLICT|IN_USE|CHANGED|DISABLED|MISMATCH/.test(error.code) ? "conflict" : "failed", message: (error instanceof WorkspaceError ? error.message : "文件操作失败，请检查目录是否存在、权限或占用情况后重试。").slice(0, 500) };
      if (error instanceof WorkspaceError) {
        const backup = error.details?.backup ?? error.details?.backupPath;
        if (typeof backup === "string") {
          const relative = path.relative(connection.path, backup);
          if (!path.isAbsolute(relative) && !relative.startsWith("..") && relative.length <= 512) failure.backup = relative;
        }
      }
      if (previous) Object.assign(previous, failure); else result.items.push(failure);
    };
    try {
      const root = await fs.realpath(connection.path);
      if (!(await fs.stat(root)).isDirectory()) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "工作目录不可用。");
      const verify = async () => {
        cancelled();
        const current = await workspace.teamContext(team.id, connection.id, connection.path);
        if (JSON.stringify(current.team) !== JSON.stringify(team) || JSON.stringify(current.directory) !== JSON.stringify(connection) || await fs.realpath(connection.path) !== root) throw new WorkspaceError("TEAM_CHANGED", "工作目录或团队设置已改变，后续文件未更新，请重新同步。");
      };
      const publish = async <T>(operation: () => T, assertOwned: () => void) => withAssetLock(path.dirname(workspace.store.filePath), ".config.lock", async (assertConfigOwned) => {
        await verify(); assertOwned(); assertConfigOwned(); return operation();
      });
      await verify();
      const maximumItems = snapshot.skills.length * connection.targets.length
        + (snapshot.schemaVersion === 3 ? snapshot.documents.length : 0)
        + connection.targets.reduce((count, target) => count + markedProjectSkills(root, target).length, 0)
        + new ProjectDocuments(root).state.documents.length;
      if (maximumItems > 511) throw new WorkspaceError("ASSETS_TOO_LARGE", "此目录的同步与退役条目超过 511 项，请先整理旧安装后重试。");
      for (const target of connection.targets) {
        await withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
          for (const skill of snapshot.skills) {
            cancelled();
            try {
              await publish(() => {
                const existing = inspectProjectSkill(root, skill.id, target);
                if (existing && existing.repository !== team.repository) throw new WorkspaceError("SKILL_CONFLICT", "同名 Skill 属于其他来源，已保留。");
                if (!existing || existing.digest !== skill.digest) new ProjectWorkConfigs(root).assertUnreferenced(skill.id, target);
                const operation = prepareSkillInstall(root, skill, team.repository, snapshot.commit, target, existing?.digest !== skill.digest ? existing?.commit : undefined);
                let committed = false;
                try {
                  const applied = operation.commit(); committed = true;
                  result.items.push({ kind: "skill", id: skill.id, target, status: applied.status === "existing" ? "unchanged" : applied.status, ...(applied.backupPath ? { backup: path.relative(root, applied.backupPath) } : {}) });
                } finally {
                  try { operation.cleanup(); }
                  catch { throw new WorkspaceError("SKILL_RECOVERY_REQUIRED", committed ? "Skill 已写入，但暂存目录未能清理，请检查工作目录后重试。" : "Skill 暂存目录未能清理，请检查工作目录后重试。"); }
                }
              }, assertOwned);
            } catch (error) { issue("skill", skill.id, error, target); }
            await setImmediate();
          }
          for (const id of markedProjectSkills(root, target).filter((id) => !snapshot.skills.some((skill) => skill.id === id))) {
            cancelled();
            if (result.items.some((item) => item.kind === "skill" && item.target === target && ["conflict", "failed"].includes(item.status))) {
              issue("skill", id, new WorkspaceError("SKILL_CONFLICT", "本目录的技能更新尚未完成，旧副本保留，处理问题后重试。"), target); continue;
            }
            try {
              await publish(() => {
                const existing = inspectProjectSkill(root, id, target);
                if (!existing || existing.repository !== team.repository) return;
                new ProjectWorkConfigs(root).assertUnreferenced(id, target);
                const applied = uninstallProjectSkill(root, id, target);
                result.items.push({ kind: "skill", id, target, status: "retired", backup: path.relative(root, applied.backupPath) });
              }, assertOwned);
            } catch (error) { issue("skill", id, error, target); }
            await setImmediate();
          }
        });
      }
      await withAssetLock(root, ".agentrecall-document.lock", async (assertOwned) => {
        const documents = new ProjectDocuments(root);
        const desired = snapshot.schemaVersion === 3 ? snapshot.documents.filter((doc) => doc.target === "AGENTS.md" ? connection.targets.includes("codex") : doc.target === "CLAUDE.md" ? connection.targets.includes("claude") : true) : [];
        for (const document of desired) {
          cancelled();
          try {
            await publish(() => {
              const applied = documents.apply(document, team.repository, snapshot.commit);
              result.items.push({ kind: "document", id: document.id, status: applied.status, ...(applied.backup ? { backup: path.relative(root, applied.backup) } : {}) });
            }, assertOwned);
          } catch (error) { issue("document", document.id, error); }
          await setImmediate();
        }
        // Disabling a client keeps its existing instruction file. Only resources
        // actually removed from the manifest are retirement candidates.
        const publishedTargets = new Set(snapshot.schemaVersion === 3 ? snapshot.documents.map((doc) => doc.target.normalize("NFC").toLowerCase()) : []);
        for (const entry of [...documents.state.documents].filter((doc) => doc.repository === team.repository && !publishedTargets.has(doc.target.normalize("NFC").toLowerCase()))) {
          cancelled();
          if (result.items.some((item) => item.kind === "document" && ["conflict", "failed"].includes(item.status))) { issue("document", entry.id, new WorkspaceError("DOCUMENT_CONFLICT", "本目录的文档更新尚未完成，旧文档保留，处理问题后重试。")); continue; }
          try { await publish(() => { const applied = documents.retire(entry.target, team.repository); result.items.push({ kind: "document", id: entry.id, status: "retired", ...(applied.backup ? { backup: path.relative(root, applied.backup) } : {}) }); }, assertOwned); }
          catch (error) { issue("document", entry.id, error); }
          await setImmediate();
        }
      });
    } catch (error) { issue("directory", connection.id, error); }
  }
  report.finishedAt = Date.now();
  if (signal?.aborted) report.status = "cancelled";
  return validatePullReport(report);
}
