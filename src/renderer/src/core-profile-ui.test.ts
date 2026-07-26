import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(
  new URL("./core-experience-api.ts", import.meta.url),
  "utf8",
);
const detailAdapterSource = readFileSync(
  new URL("./features/session-detail/core-session-detail-adapter.tsx", import.meta.url),
  "utf8",
);

describe("core-v1 renderer boundary", () => {
  it("mounts the pure Core shell without runtime-gated advanced startup work", () => {
    expect(appSource).not.toContain("CORE_RUNTIME");
    expect(appSource).not.toContain("setInterval");
    for (const advanced of [
      "loadStats",
      "loadQuotas",
      "loadRemoteSessionsCache",
      "loadSkills",
      "onMigrationProgress",
      "AiAssistantDialog",
      "RemoteSessionsDialog",
      "SkillsDialog",
    ]) {
      expect(appSource).not.toContain(advanced);
    }
    expect(apiSource).toContain("CoreExperienceApi");
    expect(apiSource).toContain("CoreApi");
  });

  it("retains only Core settings, diagnostics, update, and detail actions", () => {
    expect(appSource).toContain("Core settings");
    expect(appSource).toContain("Core diagnostics");
    expect(appSource).toContain("Native updates");
    expect(appSource).toContain("Preview legacy cleanup");
    expect(detailAdapterSource).toContain("onResume: () => void");
    expect(detailAdapterSource).toContain("onRename: () => void");
    expect(detailAdapterSource).toContain("onFavorite: () => void");
    expect(detailAdapterSource).not.toMatch(/on(?:Delete|Migrate|Summarize|Upload)/);
  });
});
