import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("./core-experience-api.ts", import.meta.url), "utf8");
const detailAdapterSource = readFileSync(
  new URL("./features/session-detail/core-session-detail-adapter.tsx", import.meta.url),
  "utf8",
);

const ADVANCED_API_NAMES = [
  "askAiAssistant",
  "getLiveSessions",
  "getMcpStatus",
  "getQuotas",
  "getStats",
  "listSessionSyncItems",
  "listSkills",
  "migrateSession",
  "openSupabaseSqlEditor",
  "setHidden",
  "setMcpEnabled",
  "setPinned",
];

describe("1.0 Core shell", () => {
  it("only mounts the search, local session, resume, and minimal settings APIs", () => {
    expect(appSource).toContain("api.searchSessionPage(options)");
    expect(appSource).toContain(".listProjects({ excludeSubagents: true, environmentId: \"local\" })");
    expect(appSource).toContain("api.getSession(");
    expect(appSource).toContain("api.getMessages(");
    expect(appSource).toContain("api.resumeSession(");
    expect(appSource).toContain("api.setFavorited(");
    expect(appSource).toContain("api.setCustomTitle(");
    expect(appSource).toContain(".getSettings()");
    expect(appSource).toContain("api.setSettings({ defaultTerminal })");
    expect(apiSource).toContain("type CoreExperienceApi = Pick<");
    expect(appSource).not.toContain("window.sessionSearch");

    for (const apiName of ADVANCED_API_NAMES) {
      expect(appSource).not.toContain(`sessionSearch.${apiName}`);
      expect(apiSource).not.toContain(`| "${apiName}"`);
    }
    expect(appSource).not.toContain("setInterval");
  });

  it("does not mount advanced dialogs or their startup chains", () => {
    for (const component of [
      "AiAssistantDialog",
      "ApiConfigDialog",
      "RemoteSessionsDialog",
      "SessionMigrationDialog",
      "SkillsDialog",
      "SshEnvironmentDialog",
      "SupabaseSetupGuide",
    ]) {
      expect(appSource).not.toContain(component);
    }
  });

  it("uses the Main-owned Core page and exact total without Renderer filtering", () => {
    expect(appSource).toContain("CoreSessionSearchResult");
    expect(appSource).toContain('environmentId: "local"');
    expect(appSource).toContain("setResults(page.sessions)");
    expect(appSource).toContain("setSessionTotalCount(page.totalCount)");
    expect(appSource).not.toContain("isCoreV1Session");
    expect(appSource).not.toContain("page.sessions.filter");
  });

  it("keeps the detail integration boundary explicit and limited to core actions", () => {
    const props = detailAdapterSource.slice(
      detailAdapterSource.indexOf("export interface CoreSessionDetailAdapterProps"),
      detailAdapterSource.indexOf("export function CoreSessionDetailAdapter"),
    );
    expect(props).toContain("onResume: () => void");
    expect(props).toContain("onFavorite: () => void");
    expect(props).toContain("onRename: () => void");
    expect(props).toContain("onLoadOlder:");
    expect(props).not.toMatch(/on(?:Delete|Migrate|Summarize|Tag|Upload|Export)/);
    expect(detailAdapterSource).toContain("<SessionDetailV1");
    expect(detailAdapterSource).toContain("id: `${session.sessionKey}:${message.index}`");
    expect(detailAdapterSource).not.toContain("window.sessionSearch");
  });
});
