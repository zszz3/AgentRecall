import { z } from "zod";
import type {
  CoreLiveSessionKey,
  CoreProjectQueryOptions,
  CoreSearchOptions,
  CoreSettingsUpdate,
  CoreTagListOptions,
  CoreTraceEventQueryOptions,
} from "../core-api";
import { CORE_SESSION_SOURCES } from "../product-profile";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const sessionKey = z.string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => !value.includes("\0"), "Session key must not contain NUL.");
const finiteTimestamp = z.number().finite();
const boundedLimit = z.number().int().min(1).max(1_000);
const boundedOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const projectPath = z.string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes("\0"), "Project path must not contain NUL.");
const tagName = z.string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "Tag must not contain NUL.");
const traceTimestamp = z.string()
  .max(128)
  .refine((value) => Number.isFinite(Date.parse(value)), "Timestamp must be a valid date.");
const coreLiveSessionKey = z.string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => /^(?:claude|codex):.+$/.test(value) && !value.includes("\0"),
    "Live session key must use a Core family.",
  )
  .transform((value): CoreLiveSessionKey => value as CoreLiveSessionKey);

const coreSourceFilter = z.union([
  z.enum(CORE_SESSION_SOURCES),
  z.enum(["claude", "codex", "all"]),
]);

export const coreSearchOptionsInput: z.ZodType<CoreSearchOptions> = z.object({
  query: z.string().max(20_000).optional(),
  tag: tagName.optional(),
  projectPath: projectPath.optional(),
  environmentId: z.enum(["all", "local"]).optional(),
  source: coreSourceFilter.optional(),
  liveStatus: z.enum(["open", "closed"]).optional(),
  liveSessionKeys: z.array(coreLiveSessionKey).max(20_000).optional(),
  visibility: z.enum(["default", "favorites"]).optional(),
  sortBy: z.enum(["activity", "created"]).optional(),
  dateFrom: finiteTimestamp.optional(),
  dateTo: finiteTimestamp.optional(),
  limit: boundedLimit.optional(),
  excludeSubagents: z.boolean().optional(),
}).strict();

export const coreTraceOptionsInput: z.ZodType<CoreTraceEventQueryOptions> = z.object({
  startTimestamp: traceTimestamp.optional(),
  endTimestamp: traceTimestamp.optional(),
  limit: boundedLimit.optional(),
}).strict();

export const coreProjectQueryOptionsInput: z.ZodType<CoreProjectQueryOptions> = z.object({
  excludeSubagents: z.boolean().optional(),
  environmentId: z.enum(["all", "local"]).optional(),
}).strict();

export const coreTagListOptionsInput: z.ZodType<CoreTagListOptions> = z.object({
  environmentId: z.enum(["all", "local"]).optional(),
  projectPath: projectPath.optional(),
  projectEnvironmentId: z.enum(["local"]).optional(),
  excludeSubagents: z.boolean().optional(),
}).strict();

const optionalProjectQueryInput = z
  .union([z.tuple([]), z.tuple([coreProjectQueryOptionsInput.optional()])])
  .transform((input): [CoreProjectQueryOptions | undefined] => [input[0]]);

const optionalTagListInput = z
  .union([z.tuple([]), z.tuple([coreTagListOptionsInput.optional()])])
  .transform((input): [CoreTagListOptions | undefined] => [input[0]]);

const messagesInput = z
  .tuple([sessionKey, boundedOffset.optional(), boundedLimit.optional()])
  .transform(
    (input): [string, number | undefined, number | undefined] => [
      input[0],
      input[1],
      input[2],
    ],
  );

const traceEventsInput = z
  .tuple([sessionKey, coreTraceOptionsInput.optional()])
  .transform(
    (input): [string, CoreTraceEventQueryOptions | undefined] => [
      input[0],
      input[1],
    ],
  );

export const coreSettingsUpdateInput: z.ZodType<CoreSettingsUpdate> = z.object({
  defaultTerminal: z.enum([
    "Terminal",
    "iTerm",
    "Ghostty",
    "WezTerm",
    "Warp",
    "WindowsTerminal",
    "PowerShell",
    "Cmd",
  ]).optional(),
  globalShortcut: z.enum([
    "Alt+Space",
    "Ctrl+Alt+Space",
    "CommandOrControl+Alt+Space",
    "",
  ]).optional(),
  claudeBinary: z.string().trim().min(1).max(32_768).refine((value) => !value.includes("\0"), "Binary path must not contain NUL.").optional(),
  codexBinary: z.string().trim().min(1).max(32_768).refine((value) => !value.includes("\0"), "Binary path must not contain NUL.").optional(),
  hideSubagentSessions: z.boolean().optional(),
  autoCheckUpdates: z.boolean().optional(),
}).strict();

export const CORE_IPC = {
  searchSessionPage: defineIpcRequest(
    "search:session-page",
    z.tuple([coreSearchOptionsInput]),
  ),
  getSession: defineIpcRequest("session:get", z.tuple([sessionKey])),
  getMessages: defineIpcRequest("session:messages", messagesInput),
  getTraceEvents: defineIpcRequest("session:trace-events", traceEventsInput),
  getLiveSessions: defineIpcRequest("sessions:live", noInput),
  listTags: defineIpcRequest("tags:list", optionalTagListInput),
  listProjects: defineIpcRequest("projects:list", optionalProjectQueryInput),
  listTagsByProject: defineIpcRequest("tags:by-project", noInput),
  listEnvironments: defineIpcRequest("environments:list", noInput),
  setCustomTitle: defineIpcRequest(
    "title:set",
    z.tuple([sessionKey, z.string().max(1_000).nullable()]),
  ),
  setFavorited: defineIpcRequest("favorite:set", z.tuple([sessionKey, z.boolean()])),
  refreshIndex: defineIpcRequest("index:refresh", noInput),
  getIndexStatus: defineIpcRequest("index:status", noInput),
  getSettings: defineIpcRequest("settings:get", noInput),
  setSettings: defineIpcRequest("settings:set", z.tuple([coreSettingsUpdateInput])),
  resumeSession: defineIpcRequest("command:resume", z.tuple([sessionKey])),
} as const;

export const CORE_EVENTS = {
  indexStatus: "index-status",
  focusSearch: "focus-search",
  openSettings: "open-settings",
} as const;
