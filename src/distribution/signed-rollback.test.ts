import { describe, expect, it } from "vitest";
import { createSignedRollbackPlan } from "./signed-rollback";

describe("signed rollback", () => {
  it("blocks an installer whose signing identity has not been verified", () => {
    expect(createSignedRollbackPlan({
      version: "0.9.0",
      releaseUrl: "https://github.com/zszz3/AgentRecall/releases/tag/v0.9.0",
      assetUrl: "https://example.invalid/AgentRecall.dmg",
      signatureVerified: false,
      signerIdentity: null,
    }, "darwin")).toMatchObject({
      allowed: false,
      failure: { code: "NATIVE_UPDATE_UNTRUSTED_ROLLBACK" },
    });
  });

  it("returns platform-specific steps only for a verified prior signed release", () => {
    const plan = createSignedRollbackPlan({
      version: "0.9.0",
      releaseUrl: "https://github.com/zszz3/AgentRecall/releases/tag/v0.9.0",
      assetUrl: "https://github.com/zszz3/AgentRecall/releases/download/v0.9.0/AgentRecall.dmg",
      signatureVerified: true,
      signerIdentity: "Developer ID Application: AgentRecall",
    }, "darwin");

    expect(plan).toMatchObject({
      allowed: true,
      version: "0.9.0",
      instructions: expect.arrayContaining([expect.stringContaining("Developer ID")]),
    });
  });
});
