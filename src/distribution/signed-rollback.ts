import {
  NATIVE_UPDATE_FAILURE_URL,
  type NativeUpdateFailure,
} from "./native-update-types";

export interface SignedRollbackRelease {
  version: string;
  releaseUrl: string;
  assetUrl: string;
  signatureVerified: boolean;
  signerIdentity: string | null;
}

export type SignedRollbackPlan =
  | {
      allowed: true;
      version: string;
      releaseUrl: string;
      assetUrl: string;
      instructions: string[];
    }
  | {
      allowed: false;
      failure: NativeUpdateFailure;
    };

export function createSignedRollbackPlan(
  release: SignedRollbackRelease,
  platform: "darwin" | "win32",
): SignedRollbackPlan {
  if (!release.signatureVerified || !release.signerIdentity) {
    return {
      allowed: false,
      failure: {
        code: "NATIVE_UPDATE_UNTRUSTED_ROLLBACK",
        message: "Rollback is blocked because the previous installer signature was not verified.",
        retryable: false,
        failureUrl: NATIVE_UPDATE_FAILURE_URL,
        releaseUrl: release.releaseUrl,
        diagnosticText: JSON.stringify({
          product: "AgentRecall",
          rollbackVersion: release.version,
          platform,
          code: "NATIVE_UPDATE_UNTRUSTED_ROLLBACK",
          signatureVerified: release.signatureVerified,
        }, null, 2),
      },
    };
  }

  return {
    allowed: true,
    version: release.version,
    releaseUrl: release.releaseUrl,
    assetUrl: release.assetUrl,
    instructions: platform === "darwin"
      ? [
          "Quit AgentRecall.",
          "Keep the versioned pre-update backup.",
          "Download the previous signed DMG from the verified Release.",
          "Verify the Developer ID signature, then replace AgentRecall in Applications.",
        ]
      : [
          "Quit AgentRecall.",
          "Keep the versioned pre-update backup.",
          "Download the previous signed NSIS installer from the verified Release.",
          "Verify the Authenticode signer, then run the installer for the current user.",
        ],
  };
}
