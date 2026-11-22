import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "agent-recall-theme";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/**
 * Reads the saved choice. "warm" was a third palette in releases up to 0.41;
 * users who chose it keep a light interface instead of jumping to the system theme.
 * index.html repeats this rule in its pre-paint script.
 */
export function readStoredTheme(value: string | null): ThemeMode {
  if (value === "light" || value === "dark") return value;
  return value === "warm" ? "light" : "system";
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  return readStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribeToSystemTheme, () => window.matchMedia(DARK_SCHEME_QUERY).matches, () => false);
}
