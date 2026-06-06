import { createContext, ReactNode, useContext, useMemo } from "react";
import { MESSAGES, type MessageKey } from "./messages";
import { DEFAULT_UI_LOCALE, type UiLocale } from "./uiLocales";

type MessageValues = Record<string, number | string>;

type I18nContextValue = {
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  locale: UiLocale;
  t: (key: MessageKey, values?: MessageValues) => string;
};

const I18nContext = createContext<I18nContextValue>(createI18n(DEFAULT_UI_LOCALE));

export function I18nProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: UiLocale;
}) {
  const value = useMemo(() => createI18n(locale), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function createI18n(locale: UiLocale): I18nContextValue {
  return {
    formatDate: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
    formatNumber: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    locale,
    t: (key, values) => interpolate(MESSAGES[locale][key] ?? MESSAGES[DEFAULT_UI_LOCALE][key], values),
  };
}

function interpolate(message: string, values?: MessageValues) {
  if (!values) {
    return message;
  }

  return message.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
}
