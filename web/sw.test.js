"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const webDirectory = __dirname;
const workerSource = fs.readFileSync(path.join(webDirectory, "sw.js"), "utf8");
const landingSource = fs.readFileSync(path.join(webDirectory, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(webDirectory, "app.html"), "utf8");
const appScriptSource = fs.readFileSync(path.join(webDirectory, "app.js"), "utf8");
const landingScriptSource = fs.readFileSync(path.join(webDirectory, "landing.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(webDirectory, "manifest.webmanifest"), "utf8"));

function workerFixture(initialCacheNames, cachedApp = null, cachedLanding = null, cachedAssets = {}) {
  const listeners = {};
  const cacheNames = new Set(initialCacheNames);
  const calls = [];
  const clients = ["one", "two"].map((name) => ({
    url: `https://pomodorough.test/${name}`,
    navigate(url) {
      calls.push(`navigate:${url}`);
      return Promise.resolve(this);
    }
  }));
  const context = {
    URL,
    Promise,
    fetch: () => Promise.reject(new Error("Unexpected fetch.")),
    caches: {
      async keys() {
        return [...cacheNames];
      },
      async delete(cacheName) {
        calls.push(`delete:${cacheName}`);
        return cacheNames.delete(cacheName);
      },
      async open() {
        return { addAll: async () => {}, put: async () => {} };
      },
      async match(request) {
        if (request === "/app") return cachedApp;
        if (request === "/" || request === "/index.html") return cachedLanding;
        if (Object.hasOwn(cachedAssets, request)) return cachedAssets[request];
        return null;
      }
    },
    self: {
      location: { origin: "https://pomodorough.test" },
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
      skipWaiting: async () => {},
      clients: {
        async claim() {
          calls.push("claim");
        },
        async matchAll(options) {
          calls.push(`match:${JSON.stringify(options)}`);
          return clients;
        }
      }
    }
  };
  vm.runInNewContext(workerSource, context, { filename: "sw.js" });
  return {
    calls,
    cacheFirst: context.cacheFirst,
    networkFirstNavigation: context.networkFirstNavigation,
    async activate() {
      let completion;
      listeners.activate({ waitUntil(promise) { completion = promise; } });
      await completion;
    }
  };
}

test("shell entry assets use cache-busting version URLs", () => {
  for (const asset of ["app.css", "sync-core.js", "sync-storage.js", "app.js"]) {
    assert.match(appSource, new RegExp(`/${asset.replace(".", "\\.")}\\?v=16`));
    assert.match(workerSource, new RegExp(`/${asset.replace(".", "\\.")}\\?v=16`));
  }
  assert.match(workerSource, /pomodorough-shell-v17/);
  assert.match(workerSource, /"\/"/);
  assert.match(workerSource, /"\/index\.html"/);
  assert.match(workerSource, /"\/app"/);
  for (const asset of ["/landing.css?v=1", "/platform-selector.js?v=1", "/landing.js?v=1", "/icon.svg"]) {
    assert.match(workerSource, new RegExp(`"${asset.replace(/[.?]/g, "\\$&")}"`));
  }
});

test("manifest and service worker stay scoped to app route", () => {
  assert.deepEqual(
    { id: manifest.id, start_url: manifest.start_url, scope: manifest.scope },
    { id: "/", start_url: "/app", scope: "/app" }
  );
  assert.match(appSource, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/);
  assert.match(landingSource, /href="\/app"[^>]*>Use Web app<\/a>/);
  assert.match(appScriptSource, /serviceWorker\.register\("\/sw\.js", \{ scope: "\/app" \}\)/);
  assert.doesNotMatch(appScriptSource, /getRegistration\("\/"\)|unregister\(\)/);
  assert.doesNotMatch(landingScriptSource, /getRegistration\("\/"\)|unregister\(\)/);
});

test("offline navigation keeps root landing and app route distinct", async () => {
  const cachedApp = { name: "cached app" };
  const cachedLanding = { name: "cached landing" };
  const fixture = workerFixture([], cachedApp, cachedLanding);
  assert.equal(
    await fixture.networkFirstNavigation({ url: "https://pomodorough.test/app/timer" }),
    cachedApp
  );
  assert.equal(
    await fixture.networkFirstNavigation({ url: "https://pomodorough.test/" }),
    cachedLanding
  );
  await assert.rejects(
    fixture.networkFirstNavigation({ url: "https://pomodorough.test/other" }),
    /Unexpected fetch/
  );
});

test("offline landing migration serves exact cached redirect assets", async () => {
  const cachedLanding = { name: "cached landing" };
  const assets = Object.fromEntries(
    ["/landing.css?v=1", "/platform-selector.js?v=1", "/landing.js?v=1", "/icon.svg"]
      .map((url) => [url, { url }])
  );
  const fixture = workerFixture([], { name: "cached app" }, cachedLanding, assets);
  assert.equal(await fixture.networkFirstNavigation({ url: "https://pomodorough.test/" }), cachedLanding);
  for (const [url, response] of Object.entries(assets)) {
    assert.equal(await fixture.cacheFirst(url), response);
  }
});

test("worker upgrade claims and reloads existing windows once", async () => {
  const fixture = workerFixture(["pomodorough-shell-v7", "unrelated-cache"]);
  await fixture.activate();
  await fixture.activate();

  assert.deepEqual(fixture.calls, [
    "delete:pomodorough-shell-v7",
    "claim",
    "match:{\"type\":\"window\",\"includeUncontrolled\":true}",
    "navigate:https://pomodorough.test/one",
    "navigate:https://pomodorough.test/two",
    "claim"
  ]);
});

test("fresh worker activation claims without reloading windows", async () => {
  const fixture = workerFixture([]);
  await fixture.activate();
  assert.deepEqual(fixture.calls, ["claim"]);
});
