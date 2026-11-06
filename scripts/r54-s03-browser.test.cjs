"use strict";

// Real Go HTTPS server, headless Chromium, and a cross-site fake Google on
// http://localhost. Every scenario first defers a sign-out: startup /me fails,
// so the cached owner signs out without CSRF, and the PWA keeps the pending
// marker and a landing token while the signed-out session stays valid. Then
// the browser signs in again through the real callback.
// Scenarios: resignin proves the callback revokes the signed-out session and
// the landing keeps the new one; field keeps a return field whose name only
// ends in "signin"; held stops the landing's location.replace at the network
// and proves the leaving page neither prepares bootstrap nor starts a second
// sign-in when a cross-tab sign-out reaches it. Each scenario returns
// "<scenario>-complete" after its last assertion, so a scenario that returns
// early cannot report success.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { chromium, request } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const landingToken = /^[0-9a-f]{32}$/;
const pendingLogoutKey = "pomodoroughPendingLogout";
const cleared = { marker: null, owner: null, token: null };
const onChooser = (url) => url.pathname === "/authorize";
const onStart = (url) => url.origin === fixture.url && url.pathname === "/auth/google/start";
const landed = (pathname) => (url) => url.origin === fixture.url && url.pathname === pathname
  && !new URLSearchParams(url.search).has("signin");
let control;

const databaseClosed = "R54S03 database closed";

// Runs in the page before app scripts. Logging IndexedDB connection closes lets
// a leg wait until a local cleanup, which ends by closing its connection, has
// finished on a page that shows no other sign of it. A page whose navigation is
// held cannot be evaluated, so the signal travels as a console message.
function reportDatabaseCloses(message) {
  window.PomodoroughAppTest = { disableAutoStart: false };
  const close = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function (...args) {
    console.debug(message);
    return close.apply(this, args);
  };
}

function watch(page, log) {
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (url.pathname === "/api/v1/auth/logout") log.logout.push(sent.url());
    if (url.origin === fixture.url && url.pathname.startsWith("/api/")) log.api.push(url.pathname);
    if (sent.isNavigationRequest() && sent.frame() === page.mainFrame()) log.navs.push(url);
  });
  page.on("console", (message) => {
    if (message.type() === "warning") log.warnings.push(message.text());
  });
  page.on("pageerror", (error) => log.errors.push(String(error)));
}

async function ready(page) {
  await page.waitForFunction(() => globalThis.PomodoroughAppTest?.state?.ready
    && !PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 30_000 });
}

async function openApp(browser, href) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "allow" });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: fixture.url, secure: true, sameSite: "Lax" })));
  await context.addInitScript(reportDatabaseCloses, databaseClosed);
  const session = { context, log: { logout: [], api: [], navs: [], warnings: [], errors: [] } };
  session.page = await context.newPage();
  watch(session.page, session.log);
  await session.page.goto(`${fixture.url}${href}`);
  await ready(session.page);
  await session.page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return session;
}

// A script-free same-origin page shares localStorage without booting a second
// app; the manifest's content type makes Chromium download the stylesheet.
async function withStoragePage(session, action) {
  const page = await session.context.newPage();
  try {
    await page.goto(`${fixture.url}/landing.css`);
    return await page.evaluate(action, pendingLogoutKey);
  } finally { await page.close(); }
}

const stored = (session) => withStoragePage(session, (key) => ({
  marker: localStorage.getItem(key), owner: localStorage.getItem(`${key}Owner`), token: localStorage.getItem(`${key}SignIn`)
}));

async function sessionValid(token) {
  const response = await control.get(`${fixture.google}/control/session?token=${encodeURIComponent(token)}`);
  assert.equal(response.status(), 200);
  return (await response.json()).valid;
}

async function sessionCookie(session) {
  return (await session.context.cookies(fixture.url)).find((cookie) => cookie.name === fixture.sessionCookie)?.value ?? null;
}

// Startup /me really fails, so the cached owner signs out without CSRF and the
// PWA sends the browser to sign-in while the signed-out session stays valid.
async function deferSignOut(session) {
  const { context, page, log } = session;
  await context.route("**/api/v1/me", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.reload();
  await page.waitForFunction(() => PomodoroughAppTest.state.offlineOwnerMode);
  await page.locator("#logoutButton").click();
  await page.waitForURL(onChooser);
  await context.unroute("**/api/v1/me");
  assert.deepEqual(log.logout, [], "a sign-out without CSRF must not send a logout request");
  const returnPath = log.navs.filter(onStart).at(-1).searchParams.get("return");
  const token = new URLSearchParams(returnPath.split("?")[1] || "").get("signin");
  assert.match(token ?? "", landingToken);
  const kept = await stored(session);
  assert.deepEqual([kept.marker, kept.token], ["1", token], "the deferred sign-out must keep its marker and landing token");
  assert.equal(await sessionValid(fixture.sessionToken), true, "the deferred sign-out must leave its session valid");
  return { returnPath, token };
}

async function historyUrls(page) {
  const cdp = await page.context().newCDPSession(page);
  try { return (await cdp.send("Page.getNavigationHistory")).entries.map((entry) => entry.url); } finally { await cdp.detach(); }
}

async function assertSignedInAgain(session) {
  assert.deepEqual(session.log.logout, [], "the landing must not revoke the new session");
  assert.deepEqual(await stored(session), cleared);
  assert.equal(await sessionValid(fixture.sessionToken), false, "the callback must revoke the signed-out session");
  const replacement = await sessionCookie(session);
  assert.notEqual(replacement, fixture.sessionToken);
  assert.equal(await sessionValid(replacement), true, "the landing must keep the new session");
  assert.equal(await session.page.evaluate(() => PomodoroughAppTest.state.authenticated), true);
  return replacement;
}

async function reSignInScenario(session) {
  const { returnPath } = await deferSignOut(session);
  await session.page.click("#pick");
  await session.page.waitForURL(landed("/app"));
  await ready(session.page);
  assert.ok(session.log.navs.some((url) => url.href === `${fixture.url}${returnPath}`), "the callback must return to the landing");
  const replacement = await assertSignedInAgain(session);
  const history = await historyUrls(session.page);
  assert.ok(history.every((url) => !new URL(url).searchParams.has("signin")), JSON.stringify(history));
  await session.page.reload();
  await ready(session.page);
  assert.deepEqual(session.log.logout, []);
  assert.equal(await sessionValid(replacement), true, "a reload after the landing must keep the new session");
  return "resignin-complete";
}

// Only a field named exactly "signin" carries the landing token. A field whose
// name only ends in "signin" goes to sign-in and comes back unchanged.
async function returnFieldScenario(session) {
  const { returnPath, token } = await deferSignOut(session);
  assert.equal(returnPath, `/app/tasks?xsignin=1&view=list&signin=${token}`);
  await session.page.click("#pick");
  await session.page.waitForURL(landed("/app/tasks"));
  await ready(session.page);
  assert.equal(new URL(session.page.url()).search, "?xsignin=1&view=list");
  await assertSignedInAgain(session);
  return "field-complete";
}

// Holds the first request for the clean landing URL, which is the landing's
// location.replace, so the leaving page stays alive until the leg releases it.
async function holdLanding(context, pathname) {
  const hold = {};
  hold.reached = new Promise((resolve) => { hold.arrive = resolve; });
  await context.route((url) => url.origin === fixture.url && url.pathname === pathname && !url.search, (route) => {
    if (hold.route) return route.continue();
    hold.route = route;
    hold.arrive();
  });
  return hold;
}

function within(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Between location.replace and unload the landing page still runs. It must not
// go on with startup as if a session had loaded, and a cross-tab sign-out that
// reaches it must not start a second sign-in. A revision stream never opens on
// a landing page, so closing one there has no observable effect.
async function heldLandingScenario(session) {
  const { context, page, log } = session;
  await deferSignOut(session);
  const hold = await holdLanding(context, "/app");
  const since = { api: log.api.length, navs: log.navs.length, warnings: log.warnings.length };
  await page.click("#pick");
  await within(hold.reached, 30_000, "the landing never replaced its URL");
  assert.deepEqual(await stored(session), cleared, "the landing must finish local cleanup before it navigates");
  const crossTabCleanup = page.waitForEvent("console", { predicate: (message) => message.text() === databaseClosed, timeout: 15_000 });
  await withStoragePage(session, (key) => localStorage.setItem(key, "1"));
  await crossTabCleanup;
  // A second sign-in would navigate in the same task that ends the cleanup, so
  // one quiet second is a wide bound for its request to show up.
  await page.waitForTimeout(1_000);
  assert.deepEqual(log.navs.slice(since.navs).filter(onStart), [], "a navigating landing must not start a second sign-in");
  assert.deepEqual(log.warnings.slice(since.warnings).filter((text) => text.startsWith("Pomodorough session deferred")), [],
    "a navigating landing must not go on with startup");
  assert.deepEqual(log.api.slice(since.api), ["/api/v1/me"], "the landing must not prepare bootstrap or open a stream");
  await hold.route.fulfill({ status: 204 });
  return "held-complete";
}

const scenarios = {
  resignin: { href: "/app", run: reSignInScenario },
  field: { href: "/app/tasks?xsignin=1&view=list", run: returnFieldScenario },
  held: { href: "/app", run: heldLandingScenario }
};

(async () => {
  assert.ok(Object.hasOwn(scenarios, fixture.scenario), `unknown scenario ${fixture.scenario}`);
  const scenario = scenarios[fixture.scenario];
  control = await request.newContext();
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const session = await openApp(browser, scenario.href);
    assert.equal(await scenario.run(session), `${fixture.scenario}-complete`);
    assert.deepEqual(session.log.errors, []);
    await session.context.close();
    console.log(`R54-S03-OK ${fixture.scenario}`);
  } finally {
    await browser.close();
    await control.dispose();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
