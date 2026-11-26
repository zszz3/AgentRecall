import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  GatewayAgentId,
  GatewayAgentWiringStatus,
  GatewayRouteTarget,
} from "../shared/ipc/model-gateway";
import { GATEWAY_AGENT_IDS } from "../shared/ipc/model-gateway";
import { writeVerifiedConfig } from "./atomic-config-write";

export interface GatewayWiringContext {
  homeDir: string;
  userDataPath: string;
  env?: NodeJS.ProcessEnv;
  gatewayBaseUrl: string;
  localToken: string;
  defaultModel: string;
  agentModels: Partial<Record<GatewayAgentId, GatewayRouteTarget>>;
}

interface BackupFileRecord {
  path: string;
  existed: boolean;
  content: string;
}

type BackupStore = Partial<Record<GatewayAgentId, { savedAt: string; files: BackupFileRecord[] }>>;

const AGENT_LABELS: Record<GatewayAgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "deepseek-harness": "DeepSeek Harness",
  pi: "Pi",
  opencode: "OpenCode",
};

const DSH_GATEWAY_KEY_ENV = "AGENTRECALL_GATEWAY_KEY";

function backupStorePath(userDataPath: string): string {
  return path.join(userDataPath, "gateway-wiring-backups.json");
}

async function readBackups(userDataPath: string): Promise<BackupStore> {
  try {
    const raw = await fsp.readFile(backupStorePath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as BackupStore : {};
  } catch {
    return {};
  }
}

async function writeBackups(userDataPath: string, backups: BackupStore): Promise<void> {
  const targetPath = backupStorePath(userDataPath);
  const contents = `${JSON.stringify(backups, null, 2)}\n`;
  await writeVerifiedConfig({
    targetPath,
    contents,
    verify: async () => { JSON.parse(await fsp.readFile(targetPath, "utf8")); },
  });
}

async function captureBackupIfNeeded(
  userDataPath: string,
  agentId: GatewayAgentId,
  filePaths: string[],
): Promise<void> {
  const backups = await readBackups(userDataPath);
  if (backups[agentId]) return;
  const files: BackupFileRecord[] = [];
  for (const filePath of filePaths) {
    const content = await readOptionalText(filePath);
    files.push({ path: filePath, existed: content !== null, content: content ?? "" });
  }
  backups[agentId] = { savedAt: new Date().toISOString(), files };
  await writeBackups(userDataPath, backups);
}

function normalizedOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function isGatewayUrl(candidate: string, gatewayBaseUrl: string): boolean {
  const clean = candidate.trim().replace(/\/+$/, "");
  const origin = normalizedOrigin(gatewayBaseUrl);
  return Boolean(clean && origin && clean.startsWith(origin));
}

function claudePaths(ctx: GatewayWiringContext) {
  const root = ctx.env?.CLAUDE_CONFIG_DIR?.trim() || path.join(ctx.homeDir, ".claude");
  return { root, settingsPath: path.join(root, "settings.json") };
}

function codexPaths(ctx: GatewayWiringContext) {
  const root = ctx.env?.CODEX_HOME?.trim() || path.join(ctx.homeDir, ".codex");
  return { root, configPath: path.join(root, "config.toml") };
}

async function deepSeekPaths(ctx: GatewayWiringContext) {
  const root = ctx.env?.DSH_HOME?.trim() || path.join(ctx.homeDir, ".dsh");
  const profilesDir = path.join(root, "profiles");
  let profileName = "desktop";
  try {
    const entries = await fsp.readdir(profilesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // Prefer interactive Desktop / default / CLI profiles instead of auxiliary acp/headless profiles.
    const preferred = ["desktop", "default", "cli"].find((name) => dirs.includes(name));
    if (preferred) {
      profileName = preferred;
    } else if (dirs.length > 0) {
      profileName = dirs.find((name) => name !== "acp" && name !== "headless") ?? dirs[0]!;
    }
  } catch {
    // Use desktop profile directory when none exists yet.
  }
  return {
    root,
    patchPath: path.join(profilesDir, profileName, "cordis.patch.yml"),
    credentialsPath: path.join(root, ".credentials.yaml"),
  };
}

function piPaths(ctx: GatewayWiringContext) {
  const root = ctx.env?.PI_CODING_AGENT_DIR?.trim() || path.join(ctx.homeDir, ".pi", "agent");
  return { root, modelsPath: path.join(root, "models.json") };
}

function openCodePaths(ctx: GatewayWiringContext) {
  const xdg = ctx.env?.XDG_CONFIG_HOME?.trim() || path.join(ctx.homeDir, ".config");
  const root = path.join(xdg, "opencode");
  return { root, configPath: path.join(root, "opencode.json") };
}

export async function inspectGatewayAgents(ctx: GatewayWiringContext): Promise<GatewayAgentWiringStatus[]> {
  const backups = await readBackups(ctx.userDataPath);
  const results: GatewayAgentWiringStatus[] = [];
  for (const agentId of GATEWAY_AGENT_IDS) {
    results.push(await inspectOneAgent(agentId, ctx, Boolean(backups[agentId])));
  }
  return results;
}

async function inspectOneAgent(
  agentId: GatewayAgentId,
  ctx: GatewayWiringContext,
  hasBackup: boolean,
): Promise<GatewayAgentWiringStatus> {
  const origin = normalizedOrigin(ctx.gatewayBaseUrl);
  const override = ctx.agentModels[agentId] ?? null;
  const label = AGENT_LABELS[agentId];

  if (agentId === "claude-code") {
    const { root, settingsPath } = claudePaths(ctx);
    const detected = await pathExists(root);
    const text = await readOptionalText(settingsPath);
    const parsed = safeJsonObject(text);
    const envObj = safeRecord(parsed?.env);
    const baseUrl = readStr(envObj?.ANTHROPIC_BASE_URL);
    const model = readStr(envObj?.ANTHROPIC_MODEL) || readStr(parsed?.model);
    const wired = isGatewayUrl(baseUrl, origin);
    const currentSummary = wired
      ? `已接入本地网关${model ? ` · ${model}` : ""}`
      : baseUrl
        ? `${baseUrl}${model ? ` · ${model}` : ""}`
        : detected
          ? "官方账号 / 默认配置"
          : "未检测到配置目录";
    return {
      agentId,
      label,
      detected,
      wired,
      hasBackup,
      configPath: settingsPath,
      currentSummary,
      routeOverride: override,
      snippet: `export ANTHROPIC_BASE_URL=${origin}/agent/claude-code\nexport ANTHROPIC_AUTH_TOKEN=${ctx.localToken}`,
    };
  }

  if (agentId === "codex") {
    const { root, configPath } = codexPaths(ctx);
    const detected = await pathExists(root);
    const text = await readOptionalText(configPath);
    const parsed = safeTomlObject(text);
    const activeProvider = readStr(parsed?.model_provider);
    const activeModel = readStr(parsed?.model);
    const providers = safeRecord(parsed?.model_providers);
    const activeSection = safeRecord(providers?.[activeProvider]);
    const baseUrl = readStr(activeSection?.base_url);
    const wired = activeProvider === "agentrecall" && isGatewayUrl(baseUrl, origin);
    const currentSummary = wired
      ? `已接入本地网关${activeModel ? ` · ${activeModel}` : ""}`
      : baseUrl
        ? `${activeProvider || "custom"} · ${baseUrl}`
        : detected
          ? "官方账号 / 默认配置"
          : "未检测到配置目录";
    return {
      agentId,
      label,
      detected,
      wired,
      hasBackup,
      configPath,
      currentSummary,
      routeOverride: override,
      snippet: `export OPENAI_BASE_URL=${origin}/agent/codex/v1\nexport OPENAI_API_KEY=${ctx.localToken}`,
    };
  }

  if (agentId === "deepseek-harness") {
    const { root, patchPath } = await deepSeekPaths(ctx);
    const detected = await pathExists(root);
    const text = await readOptionalText(patchPath);
    const list = safeYamlArray(text);
    const dsEntry = list.find((item) => item.id === "llm-deepseek" && item.disabled !== true);
    const baseUrl = readStr(safeRecord(dsEntry?.config)?.baseURL);
    const wired = isGatewayUrl(baseUrl, origin);
    const currentSummary = wired
      ? "已接入本地网关"
      : baseUrl
        ? baseUrl
        : detected
          ? "默认 DeepSeek 配置"
          : "未检测到 ~/.dsh";
    return {
      agentId,
      label,
      detected,
      wired,
      hasBackup,
      configPath: patchPath,
      currentSummary,
      routeOverride: override,
      snippet: `export OPENAI_BASE_URL=${origin}/agent/deepseek-harness/v1\nexport ${DSH_GATEWAY_KEY_ENV}=${ctx.localToken}`,
    };
  }

  if (agentId === "pi") {
    const { root, modelsPath } = piPaths(ctx);
    const detected = await pathExists(root);
    const text = await readOptionalText(modelsPath);
    const parsed = safeJsonObject(text);
    const providers = safeRecord(parsed?.providers);
    const ar = safeRecord(providers?.agentrecall);
    const baseUrl = readStr(ar?.baseUrl);
    const wired = isGatewayUrl(baseUrl, origin);
    return {
      agentId,
      label,
      detected,
      wired,
      hasBackup,
      configPath: modelsPath,
      currentSummary: wired ? "已添加 agentrecall 网关 Provider" : detected ? "使用 Pi 自身配置" : "未检测到 ~/.pi/agent",
      routeOverride: override,
      snippet: `Base URL: ${origin}/agent/pi/v1\nAPI Key: ${ctx.localToken}`,
    };
  }

  // opencode
  const { root, configPath } = openCodePaths(ctx);
  const detected = await pathExists(root);
  const text = await readOptionalText(configPath);
  const parsed = safeJsonObject(text);
  const providerObj = safeRecord(parsed?.provider);
  const ar = safeRecord(providerObj?.agentrecall);
  const baseUrl = readStr(safeRecord(ar?.options)?.baseURL);
  const wired = isGatewayUrl(baseUrl, origin);
  return {
    agentId,
    label,
    detected,
    wired,
    hasBackup,
    configPath,
    currentSummary: wired ? "已添加 agentrecall 网关 Provider" : detected ? "使用 OpenCode 自身配置" : "未检测到 ~/.config/opencode",
    routeOverride: override,
    snippet: `Base URL: ${origin}/agent/opencode/v1\nAPI Key: ${ctx.localToken}`,
  };
}

/**
 * Atomically writes the local AgentRecall gateway route into an agent's own config file,
 * saving a one-time pre-wiring snapshot so {@link restoreAgentFromGateway} can undo cleanly.
 */
export async function wireAgentToGateway(
  agentId: GatewayAgentId,
  ctx: GatewayWiringContext,
): Promise<string> {
  const origin = normalizedOrigin(ctx.gatewayBaseUrl);
  const chosenModel = ctx.agentModels[agentId]?.model || ctx.defaultModel || "default";

  if (agentId === "claude-code") {
    const { settingsPath } = claudePaths(ctx);
    await captureBackupIfNeeded(ctx.userDataPath, agentId, [settingsPath]);
    const existing = safeJsonObject(await readOptionalText(settingsPath)) ?? {};
    const env = { ...(safeRecord(existing.env) ?? {}) };
    env.ANTHROPIC_BASE_URL = `${origin}/agent/claude-code`;
    env.ANTHROPIC_AUTH_TOKEN = ctx.localToken;
    if (chosenModel && chosenModel !== "default") env.ANTHROPIC_MODEL = chosenModel;
    const next = { ...existing, env };
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    await writeVerifiedConfig({
      targetPath: settingsPath,
      contents,
      verify: async () => { JSON.parse(await fsp.readFile(settingsPath, "utf8")); },
    });
    return `已将本地网关写入 Claude Code 配置（${settingsPath}），新建会话生效。`;
  }

  if (agentId === "codex") {
    const { configPath } = codexPaths(ctx);
    await captureBackupIfNeeded(ctx.userDataPath, agentId, [configPath]);
    const existingText = (await readOptionalText(configPath)) ?? "";
    const updated = patchCodexToml(existingText, {
      baseUrl: `${origin}/agent/codex/v1`,
      token: ctx.localToken,
      model: chosenModel !== "default" ? chosenModel : undefined,
    });
    await writeVerifiedConfig({
      targetPath: configPath,
      contents: updated,
      verify: async () => { parseToml(await fsp.readFile(configPath, "utf8")); },
    });
    return `已将本地网关写入 Codex 配置（${configPath}），新建会话生效。`;
  }

  if (agentId === "deepseek-harness") {
    const { patchPath, credentialsPath } = await deepSeekPaths(ctx);
    await captureBackupIfNeeded(ctx.userDataPath, agentId, [patchPath, credentialsPath]);

    const existingCreds = safeYamlObject(await readOptionalText(credentialsPath)) ?? {};
    const refs = { ...(safeRecord(existingCreds.refs) ?? {}) };
    refs[DSH_GATEWAY_KEY_ENV] = ctx.localToken;
    const nextCreds = stringifyYaml({ version: existingCreds.version ?? 1, ...existingCreds, refs });
    await writeVerifiedConfig({
      targetPath: credentialsPath,
      contents: nextCreds,
      verify: async () => { parseYaml(await fsp.readFile(credentialsPath, "utf8")); },
    });

    const entries = safeYamlArray(await readOptionalText(patchPath));
    const idx = entries.findIndex((item) => item.id === "llm-deepseek");
    const existingCfg = idx >= 0 ? (safeRecord(entries[idx]?.config) ?? {}) : {};
    const nextEntry: Record<string, unknown> = {
      ...(idx >= 0 ? entries[idx] : {}),
      id: "llm-deepseek",
      disabled: false,
      config: {
        ...existingCfg,
        baseURL: `${origin}/agent/deepseek-harness/v1`,
        apiKeyEnv: DSH_GATEWAY_KEY_ENV,
        // DeepSeek Harness cordis.patch.yml models entries use `{ id }` objects.
        ...(chosenModel !== "default" ? { models: [{ id: chosenModel }] } : {}),
      },
    };
    const nextEntries = idx >= 0
      ? entries.map((item, i) => (i === idx ? nextEntry : item))
      : [...entries, nextEntry];
    const nextPatch = stringifyYaml(nextEntries);
    await writeVerifiedConfig({
      targetPath: patchPath,
      contents: nextPatch,
      verify: async () => { parseYaml(await fsp.readFile(patchPath, "utf8")); },
    });
    return `已将本地网关写入 DeepSeek Harness 配置（${patchPath}），重启或新建会话生效。`;
  }

  if (agentId === "pi") {
    const { modelsPath } = piPaths(ctx);
    await captureBackupIfNeeded(ctx.userDataPath, agentId, [modelsPath]);
    const existing = safeJsonObject(await readOptionalText(modelsPath)) ?? {};
    const providers = { ...(safeRecord(existing.providers) ?? {}) };
    providers.agentrecall = {
      baseUrl: `${origin}/agent/pi/v1`,
      api: "openai-completions",
      apiKey: ctx.localToken,
      models: [{ id: chosenModel, name: `AgentRecall (${chosenModel})` }],
    };
    const contents = `${JSON.stringify({ ...existing, providers }, null, 2)}\n`;
    await writeVerifiedConfig({
      targetPath: modelsPath,
      contents,
      verify: async () => { JSON.parse(await fsp.readFile(modelsPath, "utf8")); },
    });
    return `已将本地网关写入 Pi 配置（${modelsPath}）。`;
  }

  // opencode
  const { configPath } = openCodePaths(ctx);
  await captureBackupIfNeeded(ctx.userDataPath, agentId, [configPath]);
  const existing = safeJsonObject(await readOptionalText(configPath)) ?? {};
  const provider = { ...(safeRecord(existing.provider) ?? {}) };
  provider.agentrecall = {
    npm: "@ai-sdk/openai-compatible",
    name: "AgentRecall Gateway",
    options: {
      baseURL: `${origin}/agent/opencode/v1`,
      apiKey: ctx.localToken,
    },
    models: {
      [chosenModel]: { name: chosenModel },
    },
  };
  const contents = `${JSON.stringify({ ...existing, provider }, null, 2)}\n`;
  await writeVerifiedConfig({
    targetPath: configPath,
    contents,
    verify: async () => { JSON.parse(await fsp.readFile(configPath, "utf8")); },
  });
  return `已将本地网关写入 OpenCode 配置（${configPath}）。`;
}

/** Restores an agent's pre-wiring configuration from the saved snapshot. */
export async function restoreAgentFromGateway(
  agentId: GatewayAgentId,
  ctx: GatewayWiringContext,
): Promise<string> {
  const backups = await readBackups(ctx.userDataPath);
  const record = backups[agentId];
  if (!record) {
    throw new Error(`未找到 ${AGENT_LABELS[agentId]} 的接入前备份，请在原配置文件中手动调整。`);
  }
  for (const file of record.files) {
    if (file.existed) {
      await writeVerifiedConfig({
        targetPath: file.path,
        contents: file.content,
        verify: async () => { await fsp.stat(file.path); },
      });
    } else {
      await fsp.rm(file.path, { force: true });
    }
  }
  delete backups[agentId];
  await writeBackups(ctx.userDataPath, backups);
  return `已将 ${AGENT_LABELS[agentId]} 还原为接入网关前的配置。`;
}

function patchCodexToml(
  existingText: string,
  route: { baseUrl: string; token: string; model?: string },
): string {
  const lines = existingText ? existingText.replace(/\r\n/g, "\n").split("\n") : [];
  // Strip any previous [model_providers.agentrecall] block and replace top-level model_provider.
  const kept: string[] = [];
  let skippingAgentRecallBlock = false;
  let seenTable = false;
  let wroteProviderKey = false;
  let wroteModelKey = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      if (!seenTable) {
        if (!wroteProviderKey) {
          kept.push('model_provider = "agentrecall"');
          wroteProviderKey = true;
        }
        if (route.model && !wroteModelKey) {
          kept.push(`model = ${JSON.stringify(route.model)}`);
          wroteModelKey = true;
        }
        seenTable = true;
      }
      if (/^\[model_providers\.agentrecall\]$/i.test(trimmed)) {
        skippingAgentRecallBlock = true;
        continue;
      }
      skippingAgentRecallBlock = false;
    }
    if (skippingAgentRecallBlock) continue;

    if (!seenTable && /^model_provider\s*=/.test(trimmed)) {
      kept.push('model_provider = "agentrecall"');
      wroteProviderKey = true;
      continue;
    }
    if (!seenTable && route.model && /^model\s*=/.test(trimmed)) {
      kept.push(`model = ${JSON.stringify(route.model)}`);
      wroteModelKey = true;
      continue;
    }
    kept.push(line);
  }

  if (!seenTable) {
    if (!wroteProviderKey) kept.unshift('model_provider = "agentrecall"');
    if (route.model && !wroteModelKey) kept.splice(1, 0, `model = ${JSON.stringify(route.model)}`);
  }

  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  if (kept.length > 0) kept.push("");
  kept.push(
    "[model_providers.agentrecall]",
    'name = "AgentRecall Gateway"',
    `base_url = ${JSON.stringify(route.baseUrl)}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${JSON.stringify(route.token)}`,
    "requires_openai_auth = false",
    "",
  );
  return kept.join("\n");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(target: string): Promise<string | null> {
  try {
    return await fsp.readFile(target, "utf8");
  } catch {
    return null;
  }
}

function safeJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeTomlObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = parseToml(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeYamlObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = parseYaml(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeYamlArray(text: string | null): Record<string, unknown>[] {
  if (!text) return [];
  try {
    const parsed = parseYaml(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  } catch {
    return [];
  }
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
