"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webDirectory = __dirname;
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(webDirectory, "..", "package.json"), "utf8")
).version;
const english = JSON.parse(
  fs.readFileSync(path.join(webDirectory, "locales/en.json"), "utf8")
);
const rtl = JSON.parse(
  fs.readFileSync(path.join(webDirectory, "locales/ar-XB.json"), "utf8")
);
const { createI18n, validateCatalogs } = require("./i18n.js");
const viewModule = require("./app-view.js");

function trWith(catalog) {
  const i18n = createI18n({ catalogs: { en: catalog }, locale: "en" });
  return (key, values = {}, fallback = key) => {
    const translated = i18n.t(key, values);
    return translated !== key ? translated : fallback;
  };
}

function versionView({ metaContent, tr }) {
  const elements = { appVersion: { textContent: "" } };
  const document = {
    querySelector: (selector) => (
      selector === 'meta[name="pomodorough-version"]' && metaContent != null
        ? { content: metaContent }
        : null
    )
  };
  const view = viewModule.create({
    state: {},
    external: { host: { document }, elements, syncCore: {}, syncStorage: {} },
    use: { tr: tr || trWith(english) }
  });
  return { elements, view };
}

test("PWA version identity follows package.json", () => {
  assert.match(packageVersion, /^\d+\.\d+\.\d+/);
  const html = fs.readFileSync(path.join(webDirectory, "app.html"), "utf8");
  const meta = html.match(/<meta name="pomodorough-version" content="([^"]+)">/);
  assert.ok(meta, "app.html must carry a pomodorough-version meta tag");
  assert.equal(meta[1], packageVersion);
  const landing = fs.readFileSync(path.join(webDirectory, "index.html"), "utf8");
  const landingMeta = landing.match(/<meta name="pomodorough-version" content="([^"]+)">/);
  assert.ok(landingMeta, "index.html must carry a pomodorough-version meta tag");
  assert.equal(landingMeta[1], packageVersion);
  assert.match(html, /<p id="appVersion" class="app-version">/);
  assert.match(html, new RegExp(`Version ${packageVersion.replace(/\./g, "\\.")}`));
  const css = fs.readFileSync(path.join(webDirectory, "app.css"), "utf8");
  assert.match(css, /\.app-version\s*\{/);
  assert.equal(english["pattern.version"], "Version {version}");
  assert.ok(rtl["pattern.version"].includes("{version}"));
  assert.deepEqual(validateCatalogs({ en: english, "ar-XB": rtl }), []);
  const viewSource = fs.readFileSync(path.join(webDirectory, "app-view.js"), "utf8");
  assert.doesNotMatch(viewSource, new RegExp(packageVersion.replace(/\./g, "\\.")));
  assert.match(viewSource, /tr\(\s*"pattern\.version"/);
});

test("pattern version footer renders the running version", () => {
  const { elements, view } = versionView({ metaContent: packageVersion });
  view.renderVersion();
  assert.equal(elements.appVersion.textContent, `Version ${packageVersion}`);
});

test("missing version metadata falls back without crashing", () => {
  const { elements, view } = versionView({ metaContent: null });
  view.renderVersion();
  assert.equal(elements.appVersion.textContent, "Version unknown");
  const exposed = viewModule.create({
    state: {},
    external: {
      host: { document: { querySelector: () => null } },
      elements: {},
      syncCore: {},
      syncStorage: {}
    },
    use: { tr: trWith(english) }
  });
  exposed.renderVersion();
});

test("durations render refreshes the version footer", () => {
  const elements = {
    appVersion: { textContent: "" },
    phaseButtons: [],
    durationInputs: [],
    stepButtons: [],
    autoStartBreaks: { checked: false, disabled: false }
  };
  const document = {
    activeElement: null,
    querySelector: () => ({ content: packageVersion })
  };
  const view = viewModule.create({
    state: {
      timer: { status: "idle" },
      selectedPhase: "focus",
      durationsMs: {},
      autoStartBreaks: false
    },
    external: { host: { document }, elements, syncCore: {}, syncStorage: {} },
    use: { controlsBlocked: () => false, tr: trWith(english) }
  });
  view.renderDurations();
  assert.equal(elements.appVersion.textContent, `Version ${packageVersion}`);
});
