"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webDirectory = __dirname;
const { createI18n, validateCatalogs, resolveLocale } = require("./i18n.js");
const english = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/en.json"), "utf8"));
const rtl = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/ar-XB.json"), "utf8"));

test("HTML and dynamic application resource references exist in English catalog", () => {
  const html = fs.readFileSync(path.join(webDirectory, "app.html"), "utf8");
  const script = fs.readFileSync(path.join(webDirectory, "app.js"), "utf8");
  const referenced = new Set([
    ...html.matchAll(/data-i18n(?:-aria-label|-placeholder)?="([^"]+)"/g),
    ...script.matchAll(/\btr\("([^"]+)"/g)
  ].map((match) => match[1]));
  for (const key of referenced) assert.ok(Object.hasOwn(english, key), `missing English resource ${key}`);
  assert.ok(referenced.size >= 60, "practical controls and dynamic state should use resources");
});

test("dynamic presentation sinks do not bypass localization", () => {
  const script = fs.readFileSync(path.join(webDirectory, "app.js"), "utf8");
  assert.equal([...script.matchAll(/showNotice\(\s*["`]/g)].length, 0);
  assert.equal([...script.matchAll(/\.textContent\s*=\s*["`][A-Za-z]/g)].length, 0);
  for (const phrase of [
    "Run cancelled. Clear it or start again.",
    "Another device is carrying this timer.",
    "Time not recorded",
    "Durable timer storage unavailable:"
  ]) {
    const line = script.split("\n").find((candidate) => candidate.includes(phrase));
    assert.match(line || "", /tr\("/, `${phrase} must be resource-backed`);
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
});

test("missing pseudolocale keys fall back to English without exposing resource IDs", () => {
  const partial = { $meta: rtl.$meta };
  const i18n = createI18n({ catalogs: { en: english, "ar-XB": partial }, locale: "ar-XB" });
  assert.equal(i18n.t("account.delete"), "Delete account");
  assert.equal(i18n.t("unknown.key"), "unknown.key");
});
