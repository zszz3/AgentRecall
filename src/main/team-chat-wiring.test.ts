import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");

describe("Team Chat application wiring", () => {
  it("uses the application-wide managed PostgreSQL database", () => {
    expect(mainSource).toContain("database: postgresDatabase");
    expect(mainSource).not.toContain("TeamChatSettings");
    expect(mainSource).not.toContain("team-chat-pgdata");
    expect(mainSource).not.toContain("readTeamChatConnectionUrl");
  });

  it("registers and disposes Team Chat IPC alongside Automation IPC", () => {
    expect(mainSource).toContain('import { registerTeamChatIpc } from "./ipc/team-chat";');
    expect(mainSource).toContain("disposeTeamChatIpc = registerTeamChatIpc({");
    expect(mainSource).toContain("service: automationService.teamChat()");
    expect(mainSource).toContain("disposeTeamChatIpc?.();");
    expect(mainSource).toContain("disposeTeamChatIpc = null;");
  });

  it("exposes the typed Team Chat API through the existing context bridge", () => {
    expect(preloadSource).toContain('import { createTeamChatApi } from "./team-chat";');
    expect(preloadSource).toContain("teamChat: createTeamChatApi(ipcRenderer)");
  });
});
