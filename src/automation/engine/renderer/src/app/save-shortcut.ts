export const APP_SAVE_REQUEST_EVENT = "agent-recall:automation-save-request";

export function isSaveKeyboardShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}): boolean {
  return (
    event.key.toLowerCase() === "s" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey
  );
}

export function dispatchAppSaveRequest(target: EventTarget): void {
  target.dispatchEvent(new Event(APP_SAVE_REQUEST_EVENT));
}
