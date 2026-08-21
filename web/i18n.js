(() => {
  "use strict";

  const DEFAULT_LOCALE = "en";
  const SUPPORTED_LOCALES = ["en", "ar-XB"];
  const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

  function placeholders(message) {
    return [...String(message).matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).sort();
  }

  function messageBranches(message) {
    return typeof message === "string" ? { value: message } : message;
  }

  function validateCatalogs(catalogs, baseLocale = DEFAULT_LOCALE) {
    const errors = [];
    const base = catalogs[baseLocale];
    if (!base || typeof base !== "object") return [`missing base catalog ${baseLocale}`];
    const baseKeys = Object.keys(base).filter((key) => key !== "$meta").sort();
    for (const [locale, catalog] of Object.entries(catalogs)) {
      if (!catalog?.$meta || catalog.$meta.locale !== locale || !["ltr", "rtl"].includes(catalog.$meta.dir)) {
        errors.push(`${locale} has invalid $meta`);
        continue;
      }
      const keys = Object.keys(catalog).filter((key) => key !== "$meta").sort();
      for (const key of baseKeys) {
        if (!keys.includes(key)) {
          errors.push(`${locale} missing key ${key}`);
          continue;
        }
        const baseMessage = base[key];
        const translated = catalog[key];
        if ((typeof baseMessage === "string") !== (typeof translated === "string")) {
          errors.push(`${locale}.${key} message type differs from ${baseLocale}`);
          continue;
        }
        const baseBranches = messageBranches(baseMessage);
        const translatedBranches = messageBranches(translated);
        for (const branch of Object.keys(baseBranches)) {
          if (typeof translatedBranches?.[branch] !== "string") {
            errors.push(`${locale}.${key}.${branch} missing plural branch`);
            continue;
          }
          const expected = placeholders(baseBranches[branch]);
          const actual = placeholders(translatedBranches[branch]);
          if (expected.join("|") !== actual.join("|")) {
            errors.push(`${locale}.${key}.${branch} placeholder mismatch: expected ${expected.join(",") || "none"}`);
          }
        }
        for (const branch of Object.keys(translatedBranches || {})) {
          if (!(branch in baseBranches)) errors.push(`${locale}.${key}.${branch} unexpected plural branch`);
        }
      }
      for (const key of keys) {
        if (!baseKeys.includes(key)) errors.push(`${locale} has unexpected key ${key}`);
      }
    }
    return errors;
  }

  function resolveLocale(requested, supported = SUPPORTED_LOCALES) {
    const normalized = requested.filter(Boolean).map((locale) => String(locale).replace("_", "-"));
    for (const locale of normalized) {
      const exact = supported.find((candidate) => candidate.toLowerCase() === locale.toLowerCase());
      if (exact) return exact;
      const language = locale.split("-")[0].toLowerCase();
      const base = supported.find((candidate) => candidate.toLowerCase() === language);
      if (base) return base;
    }
    return supported.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : supported[0];
  }

  function format(message, values) {
    return String(message).replace(PLACEHOLDER_PATTERN, (_, name) => (
      Object.hasOwn(values, name) ? String(values[name]) : `{${name}}`
    ));
  }

  function createI18n({ catalogs, locale = DEFAULT_LOCALE, document = globalThis.document } = {}) {
    let activeLocale = resolveLocale([locale], Object.keys(catalogs));

    function setLocale(nextLocale) {
      activeLocale = resolveLocale([nextLocale], Object.keys(catalogs));
      const meta = catalogs[activeLocale]?.$meta || catalogs[DEFAULT_LOCALE].$meta;
      document?.documentElement?.setAttribute("lang", activeLocale);
      document?.documentElement?.setAttribute("dir", meta.dir);
      return activeLocale;
    }

    function t(key, values = {}) {
      const candidate = catalogs[activeLocale]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key];
      if (candidate == null) return key;
      let message = candidate;
      if (typeof candidate === "object") {
        const count = Number(values.count);
        const ruleLocale = activeLocale === "ar-XB" ? "ar" : activeLocale;
        const category = Number.isFinite(count) ? new Intl.PluralRules(ruleLocale).select(count) : "other";
        message = candidate[category] ?? candidate.other;
      }
      return format(message, values);
    }

    function applyDocument(root = document) {
      setLocale(activeLocale);
      for (const element of root?.querySelectorAll?.("[data-i18n]") || []) {
        element.textContent = t(element.dataset.i18n);
      }
      for (const element of root?.querySelectorAll?.("[data-i18n-aria-label]") || []) {
        element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
      }
      for (const element of root?.querySelectorAll?.("[data-i18n-placeholder]") || []) {
        element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
      }
      return activeLocale;
    }

    setLocale(activeLocale);
    return { t, setLocale, applyDocument, get locale() { return activeLocale; } };
  }

  async function loadBrowserI18n() {
    const queryLocale = new URLSearchParams(globalThis.location?.search || "").get("locale");
    let savedLocale = null;
    try { savedLocale = globalThis.localStorage?.getItem("pomodoroughLocale"); } catch { /* optional */ }
    const locale = resolveLocale(
      [queryLocale, savedLocale, ...(globalThis.navigator?.languages || []), globalThis.navigator?.language],
      SUPPORTED_LOCALES
    );
    const load = async (candidate) => {
      const response = await fetch(`/locales/${candidate}.json?v=2`, { cache: "no-cache" });
      if (!response.ok) throw new Error(`locale ${candidate} failed (${response.status})`);
      return response.json();
    };
    const english = await load(DEFAULT_LOCALE);
    let selected = english;
    let selectedLocale = DEFAULT_LOCALE;
    if (locale !== DEFAULT_LOCALE) {
      try {
        selected = await load(locale);
        selectedLocale = locale;
      } catch (error) {
        console.warn("Pomodorough locale fallback:", error);
      }
    }
    const catalogs = { [DEFAULT_LOCALE]: english, [selectedLocale]: selected };
    const errors = validateCatalogs(catalogs);
    if (errors.length) throw new Error(`Invalid locale catalog: ${errors.join("; ")}`);
    const instance = createI18n({ catalogs, locale: selectedLocale });
    instance.applyDocument();
    return instance;
  }

  const api = { createI18n, validateCatalogs, resolveLocale, loadBrowserI18n };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.PomodoroughI18n = api;
})();
