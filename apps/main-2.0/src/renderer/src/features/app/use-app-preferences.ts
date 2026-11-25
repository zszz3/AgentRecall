import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { LANGUAGE_STORAGE_KEY, localize, readInitialLanguage, type LanguageMode } from "../../language";
import {
  MESSAGE_FONT_SIZE_STORAGE_KEY,
  applyMessageFontSize,
  readInitialMessageFontSize,
  type MessageFontSizeScale,
} from "../../message-font-size";
import { readInitialTheme, resolveTheme, THEME_STORAGE_KEY, useSystemPrefersDark, type ThemeMode } from "../../theme";

export function useAppPreferences() {
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const resolvedTheme = resolveTheme(theme, useSystemPrefersDark());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
  const [messageFontSize, setMessageFontSize] = useState<MessageFontSizeScale>(() => readInitialMessageFontSize());
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useLayoutEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useLayoutEffect(() => {
    applyMessageFontSize(messageFontSize, (factor) => {
      void window.sessionSearch.setInterfaceZoomFactor(factor);
    });
    window.localStorage.setItem(MESSAGE_FONT_SIZE_STORAGE_KEY, messageFontSize);
  }, [messageFontSize]);

  return {
    theme,
    resolvedTheme,
    setTheme,
    language,
    setLanguage,
    messageFontSize,
    setMessageFontSize,
    t,
  };
}
