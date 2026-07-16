export type LanguageMode = "en" | "zh";

export const LANGUAGE_STORAGE_KEY = "agent-recall-language";

export function readStoredLanguage(value: string | null): LanguageMode {
  return value === "en" ? "en" : "zh";
}

export function readInitialLanguage(): LanguageMode {
  if (typeof window === "undefined") return "zh";
  return readStoredLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
}

export function localize(language: LanguageMode, en: string, zh: string): string {
  return language === "zh" ? zh : en;
}
