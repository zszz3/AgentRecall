import { useCallback, useMemo, useState } from "react";

export type WorkflowNodeInputValues = Record<string, string>;

export interface WorkflowNodeInputAdapter<Payload> {
  prepare(values: WorkflowNodeInputValues): Payload;
  submit(payload: Payload): void | Promise<void>;
}

export function updateWorkflowNodeInputDrafts(
  drafts: Record<string, WorkflowNodeInputValues>,
  scope: string,
  field: string,
  value: string,
): Record<string, WorkflowNodeInputValues> {
  return { ...drafts, [scope]: { ...(drafts[scope] ?? {}), [field]: value } };
}

export function clearWorkflowNodeInputDraft(
  drafts: Record<string, WorkflowNodeInputValues>,
  scope: string,
): Record<string, WorkflowNodeInputValues> {
  if (!(scope in drafts)) return drafts;
  const next = { ...drafts };
  delete next[scope];
  return next;
}

export function useWorkflowNodeInputController<Payload>(input: {
  scope: string;
  adapter: WorkflowNodeInputAdapter<Payload>;
}) {
  const [drafts, setDrafts] = useState<Record<string, WorkflowNodeInputValues>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const values = drafts[input.scope] ?? {};
  const error = errors[input.scope];

  const setValue = useCallback((field: string, value: string) => {
    setDrafts((current) => updateWorkflowNodeInputDrafts(current, input.scope, field, value));
  }, [input.scope]);

  const submit = useCallback(async (): Promise<boolean> => {
    try {
      const payload = input.adapter.prepare(drafts[input.scope] ?? {});
      setErrors((current) => ({ ...current, [input.scope]: undefined }));
      await input.adapter.submit(payload);
      setDrafts((current) => clearWorkflowNodeInputDraft(current, input.scope));
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setErrors((current) => ({ ...current, [input.scope]: message }));
      return false;
    }
  }, [drafts, input.adapter, input.scope]);

  return useMemo(() => ({ values, error, setValue, submit }), [error, setValue, submit, values]);
}
