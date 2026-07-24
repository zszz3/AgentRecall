import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { ActionStatus } from "../app-types";

export function ActionToast({
  status,
  onClose,
}: {
  status: ActionStatus;
  onClose(): void;
}): ReactElement {
  return (
    <div className={`action-toast ${status.kind}`} role="status" aria-live="polite">
      <span>{status.message}</span>
      {status.kind === "error" ? (
        <button
          type="button"
          className="action-toast-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
