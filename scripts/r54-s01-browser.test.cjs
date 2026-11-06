"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const loginPath = /auth\/google\/start/;
const deferredWarning = "Pomodorough server revocation deferred until reconnect:";

async function markers(page) {
  return page.evaluate(() => ({ marker: localStorage.getItem("pomodoroughPendingLogout"),
    owner: localStorage.getItem("pomodoroughPendingLogoutOwner") }));
}

async function assertEmptyWorkspace(page) {
  const counts = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pomodorough");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = [...database.objectStoreNames];
      const transaction = database.transaction(names, "readonly");
      return await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(name).count();
        request.onsuccess = () => resolve([name, request.result]);
        request.onerror = () => reject(request.error);
      })));
    } finally { database.close(); }
  });
  assert.ok(counts.length > 0);
  assert.ok(counts.every(([, count]) => count === 0), JSON.stringify(counts));
}

async function openAuthenticatedApp(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "allow" });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: fixture.url, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  const page = await context.newPage();
  const logoutRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/auth/logout") logoutRequests.push(request);
  });
  const deferredWarnings = [];
  page.on("console", (message) => {
    if (message.text().startsWith(deferredWarning)) deferredWarnings.push(message);
  });
  await page.route("**/auth/google/start?*", (route) => route.fulfill({
    contentType: "text/html", body: "OAuth intercepted for local regression" }));
  await page.goto(`${fixture.url}/app`);
  await page.waitForFunction(() => PomodoroughAppTest.state.ready && !PomodoroughAppTest.state.bootstrapBlocked);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return { context, page, logoutRequests, deferredWarnings };
}

// Startup session validation really fails, so the cached owner runs without CSRF
// while the HttpOnly session cookie stays valid on the server.
async function enterCachedOwnerWithoutCsrf({ context, page }) {
  if (fixture.mode === "offline") await context.setOffline(true);
  else await context.route("**/api/v1/me", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.reload();
  await page.waitForFunction(() => PomodoroughAppTest.state.offlineOwnerMode);
  assert.deepEqual(await page.evaluate(() => ({ csrf: PomodoroughAppTest.state.csrfToken,
    authenticated: PomodoroughAppTest.state.authenticated, validated: PomodoroughAppTest.state.sessionIdentityValidated })),
  { csrf: null, authenticated: false, validated: false });
}

async function signOutWithoutCsrf({ page, logoutRequests, deferredWarnings }) {
  await page.locator("#logoutButton").click();
  if (fixture.mode === "transient") await page.waitForURL(loginPath);
  else await page.waitForFunction(() => location.pathname !== "/app"
    || globalThis.PomodoroughAppTest?.state?.logoutRecoveryRequired === true
      && PomodoroughAppTest.captureAccountContext().database === null);
  assert.equal(logoutRequests.length, 0);
  // An offline-started page has no Sentry client, so this warning is the only
  // diagnostic that the server session may still be valid.
  assert.deepEqual(deferredWarnings.map((message) => [message.type(), message.text().split("\n")[0]]),
    [["warning", `${deferredWarning} Error: missing_csrf`]]);
  const pending = await markers(page);
  assert.equal(pending.marker, "1");
  assert.match(JSON.parse(pending.owner).userId, /^account:v1:/);
  await assertEmptyWorkspace(page);
  if (fixture.mode !== "offline") return;
  assert.equal(new URL(page.url()).pathname, "/app");
  assert.equal(await page.locator("#logoutRecovery").isVisible(), true);
  assert.equal(await page.locator("#logoutRecoveryRetry").isVisible(), true);
  assert.equal(await page.locator("#logoutButton").isVisible(), false);
}

async function recoverAndRevoke({ context, page, logoutRequests, deferredWarnings }) {
  assert.equal((await context.request.get(`${fixture.url}/api/v1/me`)).status(), 200);
  if (fixture.mode === "offline") await context.setOffline(false);
  else {
    await context.unroute("**/api/v1/me");
    await page.goto(`${fixture.url}/app`);
  }
  await page.waitForURL(loginPath);
  assert.equal(logoutRequests.length, 1);
  assert.ok(logoutRequests[0].headers()["x-csrf-token"]);
  assert.deepEqual(await markers(page), { marker: null, owner: null });
  assert.equal((await context.request.get(`${fixture.url}/api/v1/me`)).status(), 401);
  assert.equal(deferredWarnings.length, 1);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const session = await openAuthenticatedApp(browser);
    await enterCachedOwnerWithoutCsrf(session);
    await signOutWithoutCsrf(session);
    await recoverAndRevoke(session);
    console.log(`${fixture.mode}: real startup failure, local cleanup, retained markers, authenticated revoke, cleared markers, cookie rejected`);
    await session.context.close();
    console.log(`R54-S01-OK ${fixture.mode}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
