import { buildRemoteSessionSetupSql } from "./remote-session-sync";
import { buildSkillSyncSetupSql } from "./skill-sync";

export const SUPABASE_PROJECTS_URL = "https://supabase.com/dashboard/projects";

export function buildCombinedSupabaseSetupSql(): string {
  return [
    "-- AgentRecall remote sessions",
    buildRemoteSessionSetupSql(),
    "-- AgentRecall Skills",
    buildSkillSyncSetupSql(),
  ].join("\n\n");
}

export function supabaseSqlEditorUrl(projectUrl = ""): string {
  try {
    const parsed = new URL(projectUrl.trim());
    const project = /^([a-z0-9-]+)\.supabase\.co$/i.exec(parsed.hostname)?.[1];
    if (parsed.protocol !== "https:" || !project) return SUPABASE_PROJECTS_URL;
    return `https://supabase.com/dashboard/project/${project}/sql/new`;
  } catch {
    return SUPABASE_PROJECTS_URL;
  }
}
