import { z } from "zod";
import { assetId, portableAssetPath, MAX_FILE_BYTES } from "./asset-paths.js";

export const MAX_CONFIGURATION_PREVIEW_BYTES = 4 * 1024 * 1024;

const clients = z.array(z.enum(["codex", "claude"])).min(1).max(2).refine((items) => new Set(items).size === items.length).default(["codex", "claude"]);
const configName = z.string().trim().min(1).max(200).refine((value) => !/[\r\n\0]/.test(value) && !value.includes("agentrecall:team"));
const envName = z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine((name) => !["__proto__", "constructor", "prototype"].includes(name));
const plainValue = z.string().max(8192).refine((value) => !value.includes("\0") && !value.includes("${") && !value.includes("agentrecall:team"));
const environmentValue = z.union([plainValue, z.strictObject({ fromEnv: envName })]);
export const instructionEntrySchema = z.strictObject({ id: assetId, name: configName, path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".md")), targets: clients });
const mcpBase = { id: assetId, name: configName, targets: clients };
const mcpSchema = z.discriminatedUnion("transport", [
  z.strictObject({ ...mcpBase, transport: z.literal("stdio"), command: z.string().min(1).max(2048).refine((value) => !/[\r\n\0]/.test(value)), args: z.array(plainValue).max(64).default([]), env: z.record(envName, environmentValue).refine((env) => Object.keys(env).length <= 64 && Object.entries(env).every(([key, value]) => typeof value === "string" || value.fromEnv === key)).default({}) }),
  z.strictObject({ ...mcpBase, transport: z.literal("http"), url: z.string().url().max(2048).refine((value) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !value.includes("${"); } catch { return false; } }), headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/).refine((name) => !["constructor", "prototype"].includes(name)), environmentValue).refine((value) => Object.keys(value).length <= 64).default({}) }),
]);
const environmentSchema = z.strictObject({ name: envName, value: plainValue, targets: clients });
export const configurationFields = { instructions: z.array(instructionEntrySchema).max(16), mcpServers: z.array(mcpSchema).max(32), environment: z.array(environmentSchema).max(64) };

const operation = z.enum(["create", "update"]);
export const configurationChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instructions"), operation, value: instructionEntrySchema.omit({ path: true }).extend({ content: z.string().min(1).refine((value) => { const bytes = new TextEncoder().encode(value); return bytes.length <= MAX_FILE_BYTES && !value.includes("agentrecall:team") && new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value; }) }) }),
  z.strictObject({ kind: z.literal("mcp"), operation, value: mcpSchema }),
  z.strictObject({ kind: z.literal("environment"), operation, value: environmentSchema }),
]);
export type ConfigurationChange = z.infer<typeof configurationChangeSchema>;
export type ConfigurationPreview = {
  repository: string;
  revision: string;
  branch: string;
  kind: ConfigurationChange["kind"];
  operation: ConfigurationChange["operation"];
  name: string;
  files: Array<{ path: string; before: string | null; after: string }>;
};
