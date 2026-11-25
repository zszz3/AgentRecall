import { z } from "zod";
import { SKILL_INSTALL_TARGETS, type SkillInstallTarget } from "../../core/agent-skill-registry";
import type { SkillPerformanceSignals, SkillVersionGroup } from "../../core/session-store";
import type { SkillUsageAgent } from "../../core/skill-usage";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const pathInput = z.string().min(1).max(32_768).refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const remoteIdInput = z.string().trim().min(1).max(512);
const fingerprintListInput = z.array(z.string().trim().min(1).max(512)).max(500);
const pathListInput = z.array(pathInput).min(1).max(500);
const managedSkillIdInput = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..", "Invalid managed Skill id.");

/** A Skill written from text, such as a promoted experience card or user-authored Skill. `id` becomes the library ID and the `name` in SKILL.md. */
export interface LibrarySkillDraft { id: string; description: string; body: string; originLabel?: string }
/** `conflict`: the library already has a different Skill with this ID; nothing was written. */
export interface LibrarySkillCreateResult { status: "imported" | "existing" | "conflict"; managedId: string }

export interface SkillEvalSuiteCase {
  input: string;
  expectedOutput?: string;
  /** Source material supplied to the agent and judge separately from the task. */
  context?: string;
}

export interface CreateSkillEvalSuiteInput {
  skill: string;
  name: string;
  agentId: string;
  evaluatorIds: string[];
  // When true the service provisions (or reuses) the built-in LLM judge bound
  // to the execution agent's channel, so users never need to configure a
  // judge runtime before their first run.
  useBuiltinJudge: boolean;
  repetitions: number;
  cases: SkillEvalSuiteCase[];
}

export interface UpdateSkillEvalSuiteInput {
  id: string;
  name: string;
  agentId: string;
  evaluatorIds: string[];
  useBuiltinJudge: boolean;
  repetitions: number;
  cases: SkillEvalSuiteCase[];
}

export interface SkillEvalSuiteLastRun {
  id: string;
  startedAt: number;
  status: string;
  passRate: number | null;
  averageScore: number | null;
}

export interface SkillEvalSuite {
  id: string;
  name: string;
  skill: string;
  // SKILL.md hash captured at the most recent run; null before the first run.
  skillHash: string | null;
  // Current installed SKILL.md hash; null when the skill is no longer readable.
  currentHash: string | null;
  drifted: boolean;
  agentId: string;
  evaluatorIds: string[];
  repetitions: number;
  caseCount: number;
  stages: Array<{ id: string; name: string }>;
  createdAt: number;
  updatedAt: number;
  lastRun: SkillEvalSuiteLastRun | null;
}

// Evidence-ladder state for a skill in the Eval overview. "unobserved" means
// the collection pipeline cannot see this skill yet, which must never be
// presented as "never used".
export type SkillEvalObservation = "exercised" | "never-used" | "unobserved";

export interface SkillEvalOverviewItem {
  skill: string;
  // Agent of the most recent trigger; null when the skill has none yet.
  agent: SkillUsageAgent | null;
  installed: boolean;
  totalTriggers: number;
  triggers7d: number;
  triggers30d: number;
  lastTriggeredAt: number | null;
  linkedTriggers: number;
  observation: SkillEvalObservation;
}

export interface SkillEvalOverview {
  hookInstalled: boolean;
  // Whether the claude hook pipeline has demonstrably produced records.
  claudeHookObservable: boolean;
  skills: SkillEvalOverviewItem[];
}

export interface SkillEvalVersionGroup extends SkillVersionGroup {
  current: boolean;
}

export interface SkillEvalDetail {
  skill: string;
  signals: SkillPerformanceSignals;
  versions: SkillEvalVersionGroup[];
  currentHash: string | null;
  remoteVersion: number | null;
}
const librarySkillDraftInput = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  description: z.string().trim().min(1).max(1024),
  body: z.string().trim().min(1).max(100_000),
  originLabel: z.string().trim().min(1).max(64).optional(),
}).strict();
const installTargetInput = z.enum(SKILL_INSTALL_TARGETS);
const installTargetsInput = z.array(installTargetInput).max(SKILL_INSTALL_TARGETS.length);
const adoptLocalInput = z
  .union([
    z.tuple([pathInput]),
    z.tuple([pathInput, installTargetInput.optional()]),
  ])
  .transform((input): [string, SkillInstallTarget | undefined] => [input[0], input[1]]);
const relativeSkillPathInput = z.string().trim().min(1).max(512).refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const readSkillFileInput = z.tuple([pathInput, relativeSkillPathInput]);
const updateSkillFileInput = z.tuple([managedSkillIdInput, relativeSkillPathInput, z.string().max(262_144)]);
const updateTargetsInput = z
  .union([
    z.tuple([managedSkillIdInput, installTargetsInput]),
    z.tuple([managedSkillIdInput, installTargetsInput, installTargetsInput]),
  ])
  .transform((input): [string, SkillInstallTarget[], SkillInstallTarget[]] => [
    input[0],
    input[1],
    input[2] ?? [],
  ]);
const discoveryQueryInput = z.object({
  page: z.number().int().min(0).max(10_000),
  query: z.string().max(500).transform((value) => value.trim()),
}).strict();
const aiDiscoveryInput = z.object({
  query: z.string().trim().min(1).max(1_000),
  language: z.enum(["en", "zh"]),
}).strict();
const optionalRefreshInput = z
  .union([z.tuple([]), z.tuple([z.boolean().optional()])])
  .transform((input): [boolean] => [input[0] ?? false]);
const discoveredSkillIdInput = z.string().trim().min(1).max(512).refine((value) => {
  if (value.includes("\0") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.length === 3 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}, "Invalid skills.sh Skill id.");
const optionalBooleanInput = z
  .union([z.tuple([pathInput]), z.tuple([pathInput, z.boolean().optional()])])
  .transform((input): [string, boolean] => [input[0], input[1] ?? false]);
const triggersQueryInput = z
  .union([
    z.tuple([]),
    z.tuple([z.object({
      skill: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).strict().optional()]),
  ])
  .transform((input): [{ skill?: string; limit?: number }] => [input[0] ?? {}]);
const evalSuiteCreateInput = z.tuple([
  z.object({
    skill: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    agentId: z.string().trim().min(1).max(512),
    evaluatorIds: z.array(z.string().trim().min(1).max(512)).max(20),
    useBuiltinJudge: z.boolean(),
    repetitions: z.number().int().min(1).max(5),
    cases: z.array(
      z.object({
        input: z.string().trim().min(1).max(32_768),
        expectedOutput: z.string().max(32_768).optional(),
      }).strict(),
    ).min(1).max(50),
  }).strict(),
]);
const evalSuiteUpdateInput = z.tuple([
  z.object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(200),
    agentId: z.string().trim().min(1).max(512),
    evaluatorIds: z.array(z.string().trim().min(1).max(512)).max(20),
    useBuiltinJudge: z.boolean(),
    repetitions: z.number().int().min(1).max(5),
    cases: z.array(
      z.object({
        input: z.string().trim().min(1).max(32_768),
        expectedOutput: z.string().max(32_768).optional(),
      }).strict(),
    ).min(1).max(50),
  }).strict(),
]);
const skillNameInput = z.tuple([z.string().trim().min(1).max(200)]);
const evalIdInput = z.tuple([z.string().trim().min(1).max(512)]);

export const SKILLS_IPC = {
  list: defineIpcRequest("skills:list", noInput),
  listImportCandidates: defineIpcRequest("skills:import-candidates", optionalRefreshInput),
  importLocal: defineIpcRequest("skills:import-local", z.tuple([pathListInput])),
  adoptLocal: defineIpcRequest("skills:adopt-local", adoptLocalInput),
  importFolder: defineIpcRequest("skills:import-folder", noInput),
  listFiles: defineIpcRequest("skills:list-files", z.tuple([pathInput])),
  readFile: defineIpcRequest("skills:read-file", readSkillFileInput),
  updateFile: defineIpcRequest("skills:update-file", updateSkillFileInput),
  openFile: defineIpcRequest("skills:open-file", z.tuple([pathInput])),
  updateTargets: defineIpcRequest("skills:update-targets", updateTargetsInput),
  listDiscovered: defineIpcRequest("skills:discover-list", z.tuple([discoveryQueryInput])),
  aiSearchDiscovered: defineIpcRequest("skills:discover-ai-search", z.tuple([aiDiscoveryInput])),
  getDiscovered: defineIpcRequest("skills:discover-detail", z.tuple([discoveredSkillIdInput])),
  importDiscovered: defineIpcRequest("skills:discover-import", z.tuple([discoveredSkillIdInput])),
  create: defineIpcRequest("skills:create", z.tuple([librarySkillDraftInput])),
  refreshUsage: defineIpcRequest("skills:refresh-usage", noInput),
  getSyncSnapshot: defineIpcRequest("skills:sync-snapshot", noInput),
  upload: defineIpcRequest("skills:sync-upload", optionalBooleanInput),
  install: defineIpcRequest("skills:sync-install", z.tuple([remoteIdInput])),
  downloadMany: defineIpcRequest("skills:sync-download-many", z.tuple([fingerprintListInput])),
  deleteMany: defineIpcRequest("skills:sync-delete-many", z.tuple([fingerprintListInput])),
  getVersion: defineIpcRequest("skills:sync-get-version", z.tuple([remoteIdInput])),
  getDiff: defineIpcRequest("skills:sync-diff", z.tuple([pathInput.nullable(), remoteIdInput.nullable()])),
  copySetupSql: defineIpcRequest("skills:sync-copy-setup-sql", noInput),
  copyPath: defineIpcRequest("skills:copy-path", z.tuple([pathInput])),
  reveal: defineIpcRequest("skills:reveal", z.tuple([pathInput])),
  delete: defineIpcRequest("skills:delete", z.tuple([pathInput])),
  getUsageHookStatus: defineIpcRequest("skills:usage-hook-status", noInput),
  installUsageHook: defineIpcRequest("skills:install-usage-hook", noInput),
  uninstallUsageHook: defineIpcRequest("skills:uninstall-usage-hook", noInput),
  listTriggers: defineIpcRequest("skills:list-triggers", triggersQueryInput),
  getEvalOverview: defineIpcRequest("skills:eval-overview", noInput),
  getEvalDetail: defineIpcRequest("skills:eval-detail", z.tuple([z.string().trim().min(1).max(200)])),
  getEvalFindings: defineIpcRequest("skills:eval-findings", z.tuple([z.string().trim().min(1).max(200)])),
  getEvalFindingCounts: defineIpcRequest("skills:eval-finding-counts", noInput),
  listEvalSuites: defineIpcRequest("skills:eval-suites", skillNameInput),
  createEvalSuite: defineIpcRequest("skills:eval-suite-create", evalSuiteCreateInput),
  updateEvalSuite: defineIpcRequest("skills:eval-suite-update", evalSuiteUpdateInput),
  deleteEvalSuite: defineIpcRequest("skills:eval-suite-delete", evalIdInput),
  getEvalSuiteCases: defineIpcRequest("skills:eval-suite-cases", evalIdInput),
  runEvalSuite: defineIpcRequest("skills:eval-suite-run", evalIdInput),
  getEvalSuiteRuns: defineIpcRequest("skills:eval-suite-runs", evalIdInput),
  getEvalRun: defineIpcRequest("skills:eval-run-get", evalIdInput),
  cancelEvalRun: defineIpcRequest("skills:eval-run-cancel", evalIdInput),
} as const;
