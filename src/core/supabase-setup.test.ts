import { describe, expect, it } from "vitest";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "./supabase-setup";

describe("Supabase setup guidance", () => {
  it("combines the latest session and skill setup SQL", () => {
    const sql = buildCombinedSupabaseSetupSql();

    expect(sql).toContain("agent_session_remote_sessions");
    expect(sql).toContain("agent_recall_skills");
    expect(sql).toContain("agent-session-remote");
    expect(sql).toContain("agent-session-skills");
    expect(sql).toContain("grant select, insert, update, delete");
  });

  it("opens the SQL editor for a standard Supabase project URL", () => {
    expect(supabaseSqlEditorUrl("https://abc-project.supabase.co")).toBe(
      "https://supabase.com/dashboard/project/abc-project/sql/new",
    );
  });

  it("falls back to the project list for invalid or unsupported URLs", () => {
    for (const url of ["", "not-a-url", "http://abc.supabase.co", "https://example.com"]) {
      expect(supabaseSqlEditorUrl(url)).toBe("https://supabase.com/dashboard/projects");
    }
  });
});
