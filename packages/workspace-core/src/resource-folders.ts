import { z } from "zod";

export const resourceKindSchema = z.enum(["skills", "documents", "instructions", "mcp", "environment"]);
const folderPath = z.string().trim().min(1).max(240).refine(value => value.split("/").length <= 8 && value.split("/").every(part => part.trim() === part && part.length > 0 && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f<>:"|?*]/.test(part)));
export const resourceFoldersSchema = z.strictObject({
  id: resourceKindSchema,
  name: z.string().min(1).max(200),
  folders: z.array(folderPath).max(128),
  assignments: z.array(z.strictObject({ resourceId: z.string().min(1).max(128), folder: folderPath })).max(256),
}).superRefine((value, context) => {
  const paths = new Set(value.folders);
  if (new Set(value.folders.map(path => path.normalize("NFC").toLowerCase())).size !== value.folders.length) context.addIssue({ code: "custom", message: "文件夹名称重复。" });
  for (const path of paths) { const parent = path.split("/").slice(0, -1).join("/"); if (parent && !paths.has(parent)) context.addIssue({ code: "custom", message: "父文件夹不存在。" }); }
  if (new Set(value.assignments.map(item => item.resourceId)).size !== value.assignments.length || value.assignments.some(item => !paths.has(item.folder))) context.addIssue({ code: "custom", message: "资源分类无效。" });
});
export const organizationSchema = z.array(resourceFoldersSchema).max(5).refine(items => new Set(items.map(item => item.id)).size === items.length);
export const folderChangeSchema = z.strictObject({ kind: z.literal("organization"), operation: z.enum(["create", "update"]), value: resourceFoldersSchema });
export type ResourceFolders = z.infer<typeof resourceFoldersSchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
