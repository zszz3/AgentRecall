export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "agent-recall-theme";

export function readStoredTheme(value: string | null): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return readStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
}
