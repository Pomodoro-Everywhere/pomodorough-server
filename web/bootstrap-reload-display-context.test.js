"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const accountOperation = require("./account-operation.js");
const storageModule = require("./app-storage.js");

// A reload during an in-flight sync POST leaves a persisted projection behind.
// Startup then quarantines the local owner state until bootstrap resumes, so
// the live display state has no retained queues. Revalidating the persisted
// display context must keep that projection out of the reset display state.
const PROJECTION = Object.freeze({ commands: ["command-1"], taskOperations: ["task-1"] });

function storageFixture({ quarantinedLocal, assertPersistedDisplayContext }) {
  const database = { name: "pomodorough-test" };
  const identity = {
    ownerId: "owner-1", localOwnerId: "owner-1", expectedUserId: "owner-1", currentUserId: "owner-1",
    assertCurrent() {}
  };
  const notices = [];
  const validated = [];
  const state = { deviceId: "device-1", projectionPending: null, quarantinedLocal };
  const syncStorage = {
    readSyncState: async () => ({ deviceId: "device-1", projectionPending: PROJECTION }),
    assertPersistedDisplayContext(records, deviceId) {
      validated.push({ projectionPending: records.projectionPending, deviceId });
      assertPersistedDisplayContext?.();
    }
  };
  const use = { showNotice: (message) => notices.push(message), tr: (_key, _values, fallback) => fallback };
  const storage = storageModule.create({ state, external: { host: globalThis, syncCore: {}, syncStorage }, use });
  storage.setDatabaseForTest(database);
  const context = accountOperation.bind(identity, () => database, Error, () => identity);
  return { state, storage, context, notices, validated };
}

test("quarantined startup revalidation keeps the persisted projection out of the reset display state", async () => {
  const quarantinedLocal = { projectionPending: PROJECTION, pending: ["command-1"] };
  const fixture = storageFixture({ quarantinedLocal });
  await fixture.storage.validatePersistedDisplayContext(fixture.context);
  assert.equal(fixture.state.projectionPending, null);
  assert.equal(fixture.state.quarantinedLocal, quarantinedLocal);
  assert.equal(quarantinedLocal.projectionPending, PROJECTION);
  assert.deepEqual(fixture.validated, [{ projectionPending: PROJECTION, deviceId: "device-1" }]);
  assert.deepEqual(fixture.notices, []);
});

test("unquarantined revalidation still installs the persisted projection", async () => {
  const fixture = storageFixture({ quarantinedLocal: null });
  await fixture.storage.validatePersistedDisplayContext(fixture.context);
  assert.equal(fixture.state.projectionPending, PROJECTION);
  assert.equal(fixture.validated.length, 1);
});

test("quarantined revalidation still fails closed on an invalid persisted projection", async () => {
  const invalid = Object.assign(new Error("persisted projection does not match retained payloads"),
    { name: "PersistedDisplayContextError" });
  const fixture = storageFixture({
    quarantinedLocal: { projectionPending: PROJECTION },
    assertPersistedDisplayContext: () => { throw invalid; }
  });
  await assert.rejects(fixture.storage.validatePersistedDisplayContext(fixture.context), invalid);
  assert.equal(fixture.state.workspaceBlocked, true);
  assert.equal(fixture.state.bootstrapBlocked, true);
  // The notice is the localized sentence; Core's error text stays out of it.
  assert.equal(fixture.state.bootstrapError, "Data saved on this device needs recovery. Reload the page.");
  assert.equal(fixture.notices.length, 1);
  assert.equal(fixture.state.projectionPending, null);
});
