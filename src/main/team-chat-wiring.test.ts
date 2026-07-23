import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");

describe("Team Chat application wiring", () => {
  it("keeps the PostgreSQL URL in a dedicated main-process settings store", () => {
    expect(mainSource).toContain("interface TeamChatSettings");
    expect(mainSource).toContain('name: "team-chat"');
    expect(mainSource).toContain('defaults: { postgresUrl: "" }');
    expect(mainSource).toContain("readTeamChatConnectionUrl: () => teamChatSettingsStore.get(\"postgresUrl\")");
    expect(mainSource).toContain("writeTeamChatConnectionUrl: (postgresUrl) => teamChatSettingsStore.set(\"postgresUrl\", postgresUrl)");
  });

  it("places the managed local Chat database under Electron userData", () => {
    expect(mainSource).toContain('localTeamChatDataPath: path.join(app.getPath("userData"), "team-chat-pgdata")');
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
