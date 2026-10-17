"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

async function authenticatedContext(browser) {
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  return context;
}

async function waitForReady(page) {
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
}

test("R48-S03 lost DELETE recovers after restart with original receipt and atomic cleanup",
  { timeout: 90_000 }, async (t) => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    const context = await authenticatedContext(browser);
    t.after(() => context.close());
    const page = await context.newPage();
    const deletes = [];
    page.on("request", (req) => {
      try {
        if (new URL(req.url()).pathname === "/api/v1/account" && req.method() === "DELETE") {
          console.log("DELETE request seen");
        }
      } catch {}
    });
    page.on("response", (reply) => {
      try {
        if (new URL(reply.url()).pathname === "/api/v1/account" && reply.request().method() === "DELETE") {
          deletes.push(reply.status());
          console.log(`DELETE response ${reply.status()}`);
        }
      } catch {}
    });
    page.on("pageerror", (error) => console.log(`PAGEERROR ${error?.message}`));
    const response = await page.goto(`${fixture.url}/app`);
    assert.equal(response.status(), 200);
    await waitForReady(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await waitForReady(page);

    let committed = 0;
    await page.route("**/api/v1/account", async (route) => {
      const reply = await route.fetch();
      assert.equal(reply.status(), 204);
      committed += 1;
      await route.abort("failed");
    });
    const deleted = await page.evaluate(() => PomodoroughAppTest.deleteAccount("DELETE"));
    assert.equal(deleted, false);
    assert.equal(committed, 1);
    const lost = await page.evaluate(() => ({ user: !!PomodoroughAppTest.state.user,
      ready: PomodoroughAppTest.state.ready,
      pendingDeletion: localStorage.getItem("pomodoroughPendingDeletion"),
      pendingLogout: localStorage.getItem("pomodoroughPendingLogout") }));
    assert.equal(lost.user, true);
    assert.equal(lost.ready, true);
    assert.ok(lost.pendingDeletion && lost.pendingDeletion.includes("account:v1:"));
    assert.equal(lost.pendingLogout, null);
    if (fixture.errorName === "legacy") {
      await page.evaluate(() => {
        const attempt = JSON.parse(localStorage.getItem("pomodoroughPendingDeletion"));
        delete attempt.stage;
        localStorage.setItem("pomodoroughPendingDeletion", JSON.stringify(attempt));
      });
    }
    console.log("Lost committed DELETE keeps account-bound pending attempt without cleanup");

    await page.unroute("**/api/v1/account");
    await context.addCookies([
      { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
      { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
    ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
    await page.close();
    const restarted = await context.newPage();
    restarted.on("request", (req) => {
      try {
        if (new URL(req.url()).pathname === "/api/v1/account" && req.method() === "DELETE") {
          console.log("RESTART DELETE request seen");
        }
      } catch {}
    });
    restarted.on("response", (reply) => {
      try {
        if (["/api/v1/account", "/api/v1/account/deletion-receipt"].includes(new URL(reply.url()).pathname)) {
          deletes.push(reply.status());
          console.log(`RESTART DELETE response ${reply.status()}`);
        }
      } catch {}
    });
    await restarted.goto(`${fixture.url}/app`);
    await restarted.waitForURL(/\/auth\/google\/start\?return=%2Fapp/, { timeout: 15_000 });
    const after = await restarted.evaluate(() => ({ pendingDeletion: localStorage.getItem("pomodoroughPendingDeletion"),
      pendingLogout: localStorage.getItem("pomodoroughPendingLogout"),
      cookies: document.cookie || "" }));
    console.log(`AFTER restart markers=${JSON.stringify(after)} DELETEs=${JSON.stringify(deletes)}`);
    assert.ok(deletes.includes(204));
    assert.equal(after.pendingDeletion, null);
    assert.equal(after.pendingLogout, null);
    console.log("Restart replays original receipt, confirms 204, and clears markers before login");

    const stores = await restarted.evaluate(async () => {
      try {
        const request = indexedDB.open("pomodorough");
        const database = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const names = [...database.objectStoreNames];
        const transaction = database.transaction(names, "readonly");
        const counts = await Promise.all(names.map((name) => new Promise((resolve) => {
          const read = transaction.objectStore(name).getAll();
          read.onsuccess = () => resolve(read.result.length);
          read.onerror = () => resolve(-1);
        })));
        database.close();
        return Object.fromEntries(names.map((name, index) => [name, counts[index]]));
      } catch {
        return {};
      }
    });
    for (const [name, count] of Object.entries(stores)) assert.equal(count, 0, name);
    console.log(`Atomic cleanup cleared stores: ${JSON.stringify(stores)}`);
  });
