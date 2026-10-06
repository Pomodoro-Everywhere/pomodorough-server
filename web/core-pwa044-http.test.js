"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fixture, seedMeta, dump, meta, storage, sync } = require("./test/p222-completion-fixture.js");

async function httpFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwa044-http-"));
  const output = path.join(directory, "server.json");
  const child = spawn("go", ["test", "./internal/server", "-run", "^TestCorePWA044HTTPFixture$", "-count=1", "-timeout=120s"],
    { cwd: path.join(__dirname, ".."), env: { ...process.env, CORE_PWA044_HTTP_FIXTURE: output } });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const stopped = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  t.after(async () => {
    fs.writeFileSync(output + ".stop", "stop");
    assert.equal(await stopped, 0, logs);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(output)) {
    assert.equal(child.exitCode, null, logs);
    assert.ok(Date.now() < deadline, logs);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return JSON.parse(fs.readFileSync(output, "utf8"));
}

async function clientForHTTP(t, server) {
  const bootstrapResponse = await fetch(server.url + "/api/v1/bootstrap", {
    headers: { Authorization: `Bearer ${server.accessToken}` }
  });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  const current = await fixture(t);
  t.mock.timers.setTime(server.nowMs);
  const { client } = current;
  const user = { id: server.userID, accountIncarnation: bootstrap.accountIncarnation };
  Object.assign(client.state, { user, localOwnerId: sync.accountOwnerId(user), csrfToken: server.csrfToken,
    deviceId: server.deviceID, authenticated: true, sessionIdentityValidated: true });
  client.use.trustedNow = () => Date.now();
  await seedMeta(client.use.database(), { snapshot: { ...bootstrap, user }, deviceId: server.deviceID,
    deviceSequence: 0, uuidV7: null, hlc: { wallMs: bootstrap.serverHlcWallMs, counter: bootstrap.serverHlcCounter },
    canonicalHead: { wallMs: bootstrap.serverHlcWallMs, counter: bootstrap.serverHlcCounter } });
  client.external.host.navigator.onLine = true;
  Object.assign(client.use, require("./app-sync.js").create({ state: client.state, external: client.external, use: client.use, listen() {} }));
  Object.assign(client.use, require("./app-session.js").create({ state: client.state, external: client.external, use: client.use, emit() {} }));
  await client.use.reloadPersistedState();
  return { ...current, user };
}

test("Core 0.44 real Go HTTP Start and terminal Finish survive lost response, exact retry and database reopen", { timeout: 120000 }, async (t) => {
  const server = await httpFixture(t);
  const { client, core, user } = await clientForHTTP(t, server);
  const requests = [];
  let loseResponse = false;
  client.external.host.fetch = async (url, input) => {
    const response = await fetch(server.url + url, { ...input,
      headers: { ...input.headers, Authorization: `Bearer ${server.accessToken}` } });
    const responseRaw = await response.clone().text();
    requests.push({ url, body: input.body, status: response.status, responseRaw });
    assert.equal(response.status, 200, responseRaw);
    if (loseResponse) { loseResponse = false; throw new Error("Response lost after actual HTTP acceptance"); }
    return response;
  };
  assert.equal(await client.use.issueCommand("start"), true, client.notices.join("; "));
  await client.use.syncNow();
  const start = await dump(client.use.database());
  assert.equal(meta(start, "snapshot").canonicalTimer.status, "running");
  assert.deepEqual(meta(start, "canonicalResponse"), JSON.parse(requests[0].responseRaw));
  assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
  loseResponse = true;
  await client.use.syncNow();
  const lost = await dump(client.use.database());
  const claim = meta(lost, "outgoingSync");
  const finishResponse = JSON.parse(requests[1].responseRaw);
  assert.equal(finishResponse.canonicalTimer.status, "completed");
  assert.ok(finishResponse.history.some((row) => row.timerId === finishResponse.canonicalTimer.id));
  client.use.database().close();
  client.use.setDatabaseForTest(await client.use.openDatabase());
  await client.use.reloadPersistedState();
  assert.deepEqual(await dump(client.use.database()), lost);
  const database = client.use.database();
  const transaction = database.transaction.bind(database);
  database.transaction = (...argumentsList) => {
    const current = transaction(...argumentsList);
    const objectStore = current.objectStore.bind(current);
    current.objectStore = (name) => {
      const store = objectStore(name);
      if (name === "meta" && current.mode === "readwrite") {
        const put = store.put.bind(store);
        store.put = (record, ...rest) => {
          if (record.key === "canonicalResponse") throw new Error("Injected abort after queue writes");
          return put(record, ...rest);
        };
      }
      return store;
    };
    return current;
  };
  await client.use.syncNow();
  const aborted = await dump(database);
  assert.deepEqual(aborted.pending, lost.pending);
  assert.deepEqual(meta(aborted, "snapshot"), meta(lost, "snapshot"));
  assert.deepEqual(meta(aborted, "outgoingSync"), claim);
  assert.deepEqual(meta(aborted, "projectionPending"), meta(lost, "projectionPending"));
  database.transaction = transaction;
  await client.use.syncNow();
  const after = await dump(client.use.database());
  assert.equal(requests[2].body, claim.body);
  assert.equal(requests[1].body, requests[2].body);
  assert.equal(requests[2].body, requests[3].body);
  assert.deepEqual(meta(after, "snapshot").canonicalTimer, finishResponse.canonicalTimer);
  assert.deepEqual(meta(after, "snapshot").history, finishResponse.history);
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
  assert.equal(meta(after, "completionState").selection.phase, "short_break");
  assert.equal(core.call("core.version", {}).coreVersion, "0.47.0");
  if (process.env.PWA044_HTTP_EVIDENCE) fs.writeFileSync(process.env.PWA044_HTTP_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), user, requests, start, lost, aborted, after }, null, 2));
});
