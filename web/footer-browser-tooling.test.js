"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const runner = path.join(__dirname, "../scripts/footer-contrast-browser.test.cjs");
const runnerRequire = createRequire(runner);

for (const [name, env] of [
  ["default installed axe", {}],
  ["independent Playwright override", { POMODOROUGH_PLAYWRIGHT_MODULE: "/custom/playwright" }],
  ["explicit axe override", { POMODOROUGH_AXE_PATH: "/custom/axe.min.js" }],
]) {
  test(`footer browser tooling: ${name}`, () => {
    const context = vm.createContext({
      process: { env },
      require: Object.assign((id) => {
        if (id === "node:test") return () => {};
        if (id === "node:fs") return { readFileSync: () => "{}" };
        if (id === (env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright")) return { chromium: {} };
        return runnerRequire(id);
      }, { resolve: runnerRequire.resolve }),
    });
    vm.runInContext(readFileSync(runner, "utf8"), context, { filename: runner });
    const resolved = vm.runInContext("axeFile()", context);
    assert.equal(resolved, env.POMODOROUGH_AXE_PATH || runnerRequire.resolve("axe-core/axe.min.js"));
    if (!env.POMODOROUGH_AXE_PATH) {
      assert.match(readFileSync(resolved, "utf8"), /axe\.version/);
    }
  });
}
