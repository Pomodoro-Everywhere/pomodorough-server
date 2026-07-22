"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const webDirectory = __dirname;
const workerSource = fs.readFileSync(path.join(webDirectory, "sw.js"), "utf8");
const indexSource = fs.readFileSync(path.join(webDirectory, "index.html"), "utf8");

function workerFixture(initialCacheNames) {
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
      async match() {
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
    async activate() {
      let completion;
      listeners.activate({ waitUntil(promise) { completion = promise; } });
      await completion;
    }
  };
}

test("shell entry assets use cache-busting version URLs", () => {
  for (const asset of ["app.css", "sync-core.js", "sync-storage.js", "app.js"]) {
    assert.match(indexSource, new RegExp(`/${asset.replace(".", "\\.")}\\?v=13`));
    assert.match(workerSource, new RegExp(`/${asset.replace(".", "\\.")}\\?v=13`));
  }
  assert.match(workerSource, /pomodorough-shell-v13/);
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
