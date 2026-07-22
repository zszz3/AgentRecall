import { useEffect, useState } from "react";

export function updateEntityDraft<T>(current: T, next: T): T {
  return Object.is(current, next) ? current : next;
}

export function useEntityDraft<T extends { id: string }>(value: T | undefined, onDraftChange?: (value: T) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value?.id]);
  return [draft, (next: T) => {
    setDraft((current) => current === undefined ? next : updateEntityDraft(current, next));
    onDraftChange?.(next);
  }] as const;
}
