import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

/**
 * Text field that keeps a local draft and saves it on blur or Enter; Escape restores the saved value.
 * The draft follows external value changes only while the field is not focused, so a save completing
 * elsewhere does not overwrite what the user is typing.
 */
export function SettingsTextInput({
  type,
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  type: "text" | "password";
  value: string;
  disabled: boolean;
  placeholder: string;
  onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    focusedRef.current = false;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      type={type}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => {
        focusedRef.current = true;
        cancelledRef.current = false;
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelledRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
