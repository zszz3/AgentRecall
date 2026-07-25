import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(
  new URL("./features/settings/settings-dialog.tsx", import.meta.url),
  "utf8",
);
const detailSource = readFileSync(
  new URL("./features/session-detail/detail-panel.tsx", import.meta.url),
  "utf8",
);

describe("core-v1 renderer boundary", () => {
  it("uses the production Product Profile to disable advanced startup work", () => {
    expect(appSource).toContain(
      'const CORE_RUNTIME = window.sessionSearch.productProfile.id === "core-v1"',
    );
    expect(appSource).toContain(
      "if (CORE_RUNTIME) return;\n    void loadStats();",
    );
    expect(appSource).toContain(
      "if (CORE_RUNTIME) return;\n    void loadQuotas();",
    );
    expect(appSource).toContain(
      "if (CORE_RUNTIME) return;\n    void loadRemoteSessionsCache();",
    );
    expect(appSource).toContain(
      "if (CORE_RUNTIME) return;\n    if (skillsOpen) void loadSkills",
    );
    expect(appSource).toContain(
      "if (CORE_RUNTIME) return;\n    return window.sessionSearch.onMigrationProgress",
    );
    expect(appSource.match(/CORE_RUNTIME \? Promise\.resolve\(\) : loadStats\(\)/g))
      .toHaveLength(2);
  });

  it("hides advanced navigation and actions while retaining core settings and detail controls", () => {
    expect(appSource).toContain("!CORE_RUNTIME ? (");
    expect(appSource).toContain("coreMode={CORE_RUNTIME}");
    expect(settingsSource).toContain("if (coreMode) return");
    expect(settingsSource).toContain("!coreMode ? (");
    expect(detailSource).toContain("coreMode = false");
    expect(detailSource).toContain("!coreMode ? (");
    expect(detailSource).toContain("onClick={onResume}");
    expect(detailSource).toContain("onClick={onRename}");
    expect(detailSource).toContain("onClick={onFavorite}");
  });
});
