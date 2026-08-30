"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createI18n } = require("./i18n.js");
const appState = require("./app-state.js");
const appView = require("./app-view.js");

const source = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const catalogs = Object.fromEntries(["en", "ar-XB"].map((locale) => [
  locale, JSON.parse(source(`locales/${locale}.json`))
]));
const labels = [
  ["bootstrapTitle", "account.logout.recoveryTitle", "Finish pending sign-out"],
  ["bootstrapSummary", "account.logout.recoverySummary",
    "Finish sign-out before using local data. Connect and sign in to the account that owns the pending data, then retry. A different account cannot clear it."],
  ["logoutRecoveryRetry", "account.logout.recoveryRetry", "Retry sign-out cleanup"],
  ["logoutRecoverySignIn", "account.logout.recoverySignIn", "Sign in to recover"]
];
const recoveryHidden = [
  "bootstrapChoices", "bootstrapConfirmation", "bootstrapError", "bootstrapRetry", "bootstrapSignOut"
];

function expectedLabel(locale, english) {
  const vowels = { A: "Å", E: "Ë", I: "Ï", O: "Ö", U: "Û", a: "à", e: "ë", i: "ï", o: "ö", u: "û" };
  return locale === "en" ? english : `\u200f⟦${english.replace(/[AEIOUaeiou]/g, (letter) => vowels[letter])}⟧\u200f`;
}

function markupElement(id) {
  const match = source("app.html").match(new RegExp(`<([a-z][a-z0-9]*)\\b([^>]*\\bid="${id}"[^>]*)>([^<]*)`, "i"));
  assert.ok(match, `missing application element ${id}`);
  const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)]
    .map((attribute) => [attribute[1], attribute[2]]));
  return {
    attributes, dataset: attributes["data-i18n"] ? { i18n: attributes["data-i18n"] } : {},
    textContent: match[3], hidden: /\bhidden\b/.test(match[2]), disabled: false, open: false,
    setAttribute(name, value) { attributes[name] = value; },
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
}

function recoveryFixture(locale) {
  const ids = [...labels.map(([id]) => id), ...recoveryHidden, "bootstrapDialog", "logoutRecovery"];
  const elements = Object.fromEntries(ids.map((id) => [id, markupElement(id)]));
  const document = {
    documentElement: { setAttribute(name, value) { this[name] = value; } },
    querySelectorAll: (selector) => selector === "[data-i18n]"
      ? Object.values(elements).filter((element) => element.dataset.i18n) : []
  };
  const host = { document, navigator: { onLine: true } };
  const state = { logoutRecoveryRequired: true, logoutRecoveryBusy: false, bootstrapFocusTarget: null };
  const external = { host, elements, syncCore: { bootstrapDialogView: () => ({ open: false }) } };
  const language = appState.create({ state, external, use: {} });
  const i18n = createI18n({ catalogs, locale, document });
  language.setI18nForTest(i18n);
  i18n.applyDocument();
  const view = appView.create({ state, external, use: { tr: language.tr } });
  return { elements, document, host, state, i18n, view };
}

function referenceAudit(overrides = {}) {
  const tests = new Map();
  const auditFile = path.join(__dirname, "i18n.test.js");
  vm.runInNewContext(source("i18n.test.js"), {
    __dirname,
    require(name) {
      if (name === "node:test") return (title, callback) => tests.set(title, callback);
      if (name === "node:fs") return {
        readFileSync(file, encoding) {
          return overrides[path.relative(__dirname, file)] ?? fs.readFileSync(file, encoding);
        }
      };
      return require(name);
    }
  }, { filename: auditFile });
  const audit = tests.get("HTML and dynamic application resource references exist in English catalog");
  assert.equal(typeof audit, "function");
  return audit;
}

function assertMissingResource(overrides, key) {
  assert.throws(referenceAudit(overrides), {
    code: "ERR_ASSERTION", message: `missing English resource ${key}`
  });
}

for (const locale of ["en", "ar-XB"]) {
  for (const [id, key, english] of labels) {
    test(`P228 ${locale} provides native ${key} through real i18n`, () => {
      const i18n = createI18n({ catalogs, locale });
      assert.ok(Object.hasOwn(catalogs[locale], key), `missing ${locale} resource ${key}`);
      assert.equal(catalogs[locale][key], expectedLabel(locale, english));
      assert.equal(i18n.t(key), expectedLabel(locale, english));
    });

    test(`P228 ${locale} renders ${id} from actual recovery markup and view`, () => {
      const { elements, view, document } = recoveryFixture(locale);
      view.renderBootstrapDialog();
      assert.equal(elements[id].textContent, expectedLabel(locale, english));
      assert.equal(document.documentElement.lang, locale);
      assert.equal(document.documentElement.dir, locale === "en" ? "ltr" : "rtl");
      if (id.startsWith("logoutRecovery")) {
        assert.equal(elements[id].dataset.i18n, key);
        assert.equal(elements[id].attributes.type, "button");
      }
    });
  }

  test(`P228 ${locale} preserves recovery busy, connectivity and normal-dialog states`, () => {
    const { state, host, elements, view } = recoveryFixture(locale);
    for (const [busy, online] of [[false, true], [true, true], [true, false], [false, false], [false, true]]) {
      state.logoutRecoveryBusy = busy;
      host.navigator.onLine = online;
      const before = structuredClone(state);
      view.renderBootstrapDialog();
      assert.deepEqual(state, before);
      assert.equal(elements.logoutRecovery.hidden, false);
      assert.equal(elements.bootstrapDialog.open, true);
      assert.equal(elements.bootstrapDialog.attributes["aria-busy"], String(busy));
      assert.equal(elements.logoutRecoveryRetry.disabled, busy);
      assert.equal(elements.logoutRecoverySignIn.disabled, busy || !online);
      for (const id of recoveryHidden) assert.equal(elements[id].hidden, true, id);
    }
    state.logoutRecoveryRequired = false;
    view.renderBootstrapDialog();
    assert.equal(elements.logoutRecovery.hidden, true);
    assert.equal(elements.bootstrapDialog.open, false);
  });
}

test("P228 changing locale relocalizes both recovery buttons and dynamic labels", () => {
  const { i18n, elements, view } = recoveryFixture("en");
  for (const locale of ["en", "ar-XB", "en"]) {
    i18n.setLocale(locale);
    i18n.applyDocument();
    view.renderBootstrapDialog();
    for (const [id, , english] of labels) assert.equal(elements[id].textContent, expectedLabel(locale, english));
  }
});

for (const [, key] of labels.slice(0, 2)) {
  test(`P228 existing resource audit rejects absent multiline ${key}`, () => {
    const missing = { ...catalogs.en };
    delete missing[key];
    assertMissingResource({ "locales/en.json": JSON.stringify(missing) }, key);
  });
}

test("P228 existing resource audit accepts whitespace after tr opening parenthesis", () => {
  for (const whitespace of ["", " ", "\t", "\n  ", "\r\n\t"]) {
    for (const receiver of ["", "this.", "use.", "this.use."]) {
      const key = "p228.audit.missingMultiline";
      const application = `${source("app-view.js")}\n${receiver}tr(${whitespace}"${key}", {}, "fallback");`;
      assertMissingResource({ "app-view.js": application }, key);
    }
  }
});

test("P228 existing resource audit retains every prior module and markup selection", () => {
  referenceAudit()();
  for (const file of ["app.js", "app-state.js", "app-storage.js", "app-actions.js", "app-sync.js",
    "app-bootstrap.js", "app-session.js", "app-view.js"]) {
    const key = "p228.audit.missingModule";
    assertMissingResource({ [file]: `${source(file)}\ntr("${key}");` }, key);
  }
  for (const attribute of ["data-i18n", "data-i18n-aria-label", "data-i18n-placeholder"]) {
    const key = "p228.audit.missingAttribute";
    assertMissingResource({ "app.html": `${source("app.html")}\n<button ${attribute}="${key}"></button>` }, key);
  }
});
