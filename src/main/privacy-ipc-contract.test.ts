import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const coreIpcSource = readFileSync(new URL("./ipc/core.ts", import.meta.url), "utf8");
const privacyServiceSource = readFileSync(
  new URL("./services/core-privacy-service.ts", import.meta.url),
  "utf8",
);
const preloadSource = readFileSync(new URL("../preload/core-api.ts", import.meta.url), "utf8");

describe("trusted privacy IPC integration", () => {
  it("registers privacy handlers behind the same trusted Core registrar", () => {
    expect(mainSource).toContain("createCorePrivacyService");
    expect(mainSource).toContain("registerCoreIpc(createTrustedCoreIpcRegistrar()");
    expect(coreIpcSource).toContain("registerPrivacyIpc(ipc, dependencies.privacyService)");
  });

  it("keeps filesystem roots, plans, and confirmation tokens in Main", () => {
    expect(privacyServiceSource).toContain("retainedPlans");
    expect(privacyServiceSource).toContain("plan.confirmationToken");
    expect(privacyServiceSource).toContain("pathMode: \"home\"");
    expect(preloadSource).not.toContain("confirmationToken");
    expect(preloadSource).not.toContain("backupRoot");
    expect(preloadSource).not.toContain("homeDir");
  });
});
