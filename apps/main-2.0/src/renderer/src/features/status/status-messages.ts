import type { Dispatch, SetStateAction } from "react";
import type { ActionStatus } from "../../app-types";

/**
 * Shows a success message and clears it after `durationMs`, unless another message replaced it
 * in the meantime.
 */
export function showTransientSuccess(
  setStatus: Dispatch<SetStateAction<ActionStatus | null>>,
  message: string,
  durationMs = 1800,
): void {
  setStatus({ kind: "success", message });
  window.setTimeout(() => {
    setStatus((current) => (current?.kind === "success" && current.message === message ? null : current));
  }, durationMs);
}

/** Readable text of a thrown value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
