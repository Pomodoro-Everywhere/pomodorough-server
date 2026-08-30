"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webDirectory = __dirname;
const { createI18n, validateCatalogs, resolveLocale, loadBrowserI18n } = require("./i18n.js");
const english = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/en.json"), "utf8"));
const rtl = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/ar-XB.json"), "utf8"));
const applicationScript = [
  "app.js", "app-state.js", "app-storage.js", "app-actions.js", "app-sync.js",
  "app-bootstrap.js", "app-session.js", "app-view.js"
].map((file) => fs.readFileSync(path.join(webDirectory, file), "utf8")).join("\n");

test("HTML and dynamic application resource references exist in English catalog", () => {
  const html = fs.readFileSync(path.join(webDirectory, "app.html"), "utf8");
  const referenced = new Set([
    ...html.matchAll(/data-i18n(?:-aria-label|-placeholder)?="([^"]+)"/g),
    ...applicationScript.matchAll(/\btr\(\s*"([^"]+)"/g)
  ].map((match) => match[1]));
  for (const key of referenced) assert.ok(Object.hasOwn(english, key), `missing English resource ${key}`);
  assert.ok(referenced.size >= 60, "practical controls and dynamic state should use resources");
});

test("dynamic presentation sinks do not bypass localization", () => {
  assert.equal([...applicationScript.matchAll(/showNotice\(\s*["`]/g)].length, 0);
  assert.equal([...applicationScript.matchAll(/\.textContent\s*=\s*["`][A-Za-z]/g)].length, 0);
  const notification = applicationScript.match(/new NotificationType\(([\s\S]*?)\n\s*\);/)?.[1] || "";
  assert.match(notification, /completionAlertTitle\(/, "notification title must be resource-backed");
  assert.match(notification, /body:\s*this\.use\.tr\("timer\.notification\.body"/, "notification body must be resource-backed");
  for (const phrase of [
    "Run cancelled. Clear it or start again.",
    "Another device is carrying this timer.",
    "Time not recorded",
    "Durable timer storage unavailable:"
  ]) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const translatedCall = `(?:(?:use\\.)?tr\\(|call\\(application,\\s*"tr",)`;
    assert.match(applicationScript, new RegExp(`${translatedCall}[\\s\\S]{0,160}${escaped}`),
      `${phrase} must be resource-backed`);
  }
});

test("English and RTL pseudolocale catalogs have matching messages, placeholders, and plurals", () => {
  assert.deepEqual(validateCatalogs({ en: english, "ar-XB": rtl }), []);
  assert.equal(english.$meta.dir, "ltr");
  assert.equal(rtl.$meta.dir, "rtl");
  assert.ok(Object.keys(english).length >= 70, "practical app surfaces should be resource-backed");
});

test("catalog validation rejects missing placeholders and plural branches", () => {
  const broken = structuredClone(rtl);
  broken["account.logout.pending"] = { one: "broken", other: "{count} only" };
  const errors = validateCatalogs({ en: english, "ar-XB": broken });
  assert.ok(errors.some((error) => error.includes("account.logout.pending.one") && error.includes("placeholder")));
});

test("locale resolution uses exact, language, then English fallback", () => {
  assert.equal(resolveLocale(["ar-XB"], ["en", "ar-XB"]), "ar-XB");
  assert.equal(resolveLocale(["en-GB"], ["en", "ar-XB"]), "en");
  assert.equal(resolveLocale(["fr-FR"], ["en", "ar-XB"]), "en");
});

test("translation formats placeholders, applies plural rules, and switches document direction", () => {
  const attributes = {};
  const document = {
    documentElement: {
      setAttribute(name, value) { attributes[name] = value; }
    },
    querySelectorAll() { return []; }
  };
  const i18n = createI18n({ catalogs: { en: english, "ar-XB": rtl }, locale: "en", document });
  assert.equal(i18n.t("timer.start", { phase: "focus" }), "Start focus");
  assert.match(i18n.t("account.logout.pending", { count: 1 }), /^1 change is/);
  assert.match(i18n.t("account.logout.pending", { count: 2 }), /^2 changes are/);
  i18n.setLocale("ar-XB");
  assert.equal(attributes.lang, "ar-XB");
  assert.equal(attributes.dir, "rtl");
  assert.match(i18n.t("timer.start", { phase: "focus" }), /⟦.*focus.*⟧/);
  assert.match(i18n.t("timer.notification.body"), /⟦.*Pömödöröûgh.*⟧/);
});

test("missing pseudolocale keys fall back to English without exposing resource IDs", () => {
  const partial = { $meta: rtl.$meta };
  const i18n = createI18n({ catalogs: { en: english, "ar-XB": partial }, locale: "ar-XB" });
  assert.equal(i18n.t("account.delete"), "Delete account");
  assert.equal(i18n.t("unknown.key"), "unknown.key");
});

test("catalog validation reports metadata, shape, key, and plural contract violations", () => {
  const base = {
    $meta: { locale: "en", dir: "ltr" },
    simple: "Hello {name}",
    count: { one: "{count} item", other: "{count} items" }
  };
  const invalidMeta = { $meta: { locale: "wrong", dir: "sideways" }, simple: "Hello {name}", count: base.count };
  assert.deepEqual(validateCatalogs({ en: base, fr: invalidMeta }), ["fr has invalid $meta"]);

  const broken = {
    $meta: { locale: "fr", dir: "ltr" },
    simple: { value: "Bonjour {name}" },
    count: { one: "un", many: "beaucoup", other: "{count} éléments" },
    extra: "unexpected"
  };
  const errors = validateCatalogs({ en: base, fr: broken });
  assert.ok(errors.some((error) => error.includes("fr.simple message type differs")));
  assert.ok(errors.some((error) => error.includes("fr.count.one placeholder mismatch")));
  assert.ok(errors.some((error) => error.includes("fr.count.many unexpected plural branch")));
  assert.ok(errors.some((error) => error.includes("fr has unexpected key extra")));

  const missing = { $meta: { locale: "fr", dir: "rtl" }, simple: "Bonjour {name}" };
  assert.ok(validateCatalogs({ en: base, fr: missing }).some((error) => error === "fr missing key count"));
  const missingBranch = {
    $meta: { locale: "fr", dir: "ltr" }, simple: "Bonjour {name}", count: { other: "{count} éléments" }
  };
  assert.ok(validateCatalogs({ en: base, fr: missingBranch })
    .some((error) => error === "fr.count.one missing plural branch"));
  assert.deepEqual(validateCatalogs({}, "missing"), ["missing base catalog missing"]);
});

test("document localization covers text, labels, placeholders, and absent substitutions", () => {
  const updates = [];
  const element = (dataset) => ({
    dataset,
    set textContent(value) { updates.push(["text", value]); },
    setAttribute(name, value) { updates.push([name, value]); }
  });
  const document = {
    documentElement: { setAttribute: (name, value) => updates.push([name, value]) },
    querySelectorAll(selector) {
      if (selector === "[data-i18n]") return [element({ i18n: "simple" })];
      if (selector === "[data-i18n-aria-label]") return [element({ i18nAriaLabel: "simple" })];
      return [element({ i18nPlaceholder: "simple" })];
    }
  };
  const catalogs = { en: { $meta: { locale: "en", dir: "ltr" }, simple: "Hello {name}", count: { other: "{count} items" } } };
  const i18n = createI18n({ catalogs, locale: "en-US", document });
  assert.equal(i18n.applyDocument(), "en");
  assert.equal(i18n.t("simple"), "Hello {name}");
  assert.equal(i18n.t("count", { count: "not-a-number" }), "not-a-number items");
  assert.ok(updates.some(([name, value]) => name === "placeholder" && value === "Hello {name}"));
});

async function withBrowserGlobals(values, operation) {
  const descriptors = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    return await operation();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("browser locale loading honors query selection and applies the selected catalog", async () => {
  const attributes = [];
  const requests = [];
  const document = {
    documentElement: { setAttribute: (name, value) => attributes.push([name, value]) },
    querySelectorAll: () => []
  };
  const instance = await withBrowserGlobals({
    location: { search: "?locale=ar-XB" }, localStorage: { getItem: () => "en" },
    navigator: { languages: ["en-US"], language: "en" }, document,
    fetch: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => url.includes("ar-XB") ? rtl : english };
    }
  }, loadBrowserI18n);
  assert.equal(instance.locale, "ar-XB");
  assert.deepEqual(requests.map(([url]) => url), ["/locales/en.json?v=2", "/locales/ar-XB.json?v=2"]);
  assert.ok(requests.every(([, options]) => options.cache === "no-cache"));
  assert.ok(attributes.some(([name, value]) => name === "dir" && value === "rtl"));
});

test("browser locale loading falls back after storage and translated-catalog failures", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const instance = await withBrowserGlobals({
      location: { search: "" }, localStorage: { getItem() { throw new Error("blocked"); } },
      navigator: { languages: ["ar-XB"], language: "en" },
      document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
      fetch: async (url) => url.includes("ar-XB")
        ? { ok: false, status: 503, json: async () => rtl }
        : { ok: true, json: async () => english }
    }, loadBrowserI18n);
    assert.equal(instance.locale, "en");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1]), /locale ar-XB failed \(503\)/);
  } finally {
    console.warn = originalWarn;
  }
});
