"use strict";

// R43-S04: task selection and the active-focus retarget must commit atomically
// inside the guarded workspace transaction. A failed second write must abort
// both members and report failure, a same-choice retry must recover, and a
// restart must replay the exact durable claim. A retained selection without
// its retarget (legacy partial failure) must surface an explicit recovery
// state instead of a silent unrecoverable success or no-op.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, seedMeta, dump, meta, startFocus, nowMs, storage } = require("./test/p222-completion-fixture.js");

function mutationInput(client, extra) {
  return { ...client.use.captureAccountContext(), deviceId: client.state.deviceId,
    tabId: client.use.tabId(), nowMs, localNowMs: nowMs, leaseMs: 60000,
    timerUuid: "12345678-1234-4234-8234-123456789012", ...extra };
}

async function prepared(t) {
  const value = await fixture(t);
  value.client.external.sharedCoreHost.SharedCore = { load: async () => value.core };
  await seedMeta(value.client.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await value.client.use.reloadPersistedState();
  return value;
}

async function selectSecondTask(client, core) {
  assert.equal(await client.use.addTask("First task"), true, client.notices.join("; "));
  const firstId = client.state.selectedTaskId;
  await startFocus(client);
  const start = structuredClone(client.state.pending[0]);
  const second = core.taskIdentity({ title: "Second task" });
  await storage.planWorkspaceMutation(client.use.database(), mutationInput(client, {
    intent: { kind: "upsertTask", title: second.title }, preference: true }));
  await client.use.reloadPersistedState();
  return { firstId, start, second };
}

function failStoreAdd(t, database, storeName, message) {
  const transaction = database.transaction.bind(database);
  t.mock.method(database, "transaction", (...args) => {
    const current = transaction(...args);
    const objectStore = current.objectStore.bind(current);
    current.objectStore = (name) => {
      const store = objectStore(name);
      if (name === storeName && current.mode === "readwrite") {
        store.add = () => { throw new Error(message); };
      }
      return store;
    };
    return current;
  });
}

function selectedFor(records, taskId) {
  return records.pendingSelectedTasks.filter((operation) => operation.taskId === taskId);
}

function retargetsFor(records) {
  return records.pending.filter((command) => command.type === "retarget");
}

test("R43-S04 failed second write aborts selection and retarget without success", async (t) => {
  const { client, core, open } = await prepared(t);
  const setup = await selectSecondTask(client, core);
  const secondId = setup.second.id;
  const before = await dump(client.use.database());
  failStoreAdd(t, client.use.database(), "pendingSelectedTasks", "injected selection write failure");
  assert.equal(await client.use.issueSelectedTaskOperation(secondId), false);
  assert.ok(client.notices.length > 0, "partial failure must be user-visible");
  t.mock.restoreAll();
  const after = await dump(client.use.database());
  assert.deepEqual(after, before);
  assert.deepEqual(retargetsFor(after), []);
  await client.use.reloadPersistedState();
  assert.equal(client.state.selectedTaskId, setup.firstId);
  assert.equal(client.state.timer.taskId, setup.start.taskId);
  const reopened = await open();
  await reopened.use.reloadPersistedState();
  assert.deepEqual(await dump(reopened.use.database()), before);
});

test("R43-S04 same-choice retry after failure commits selection and retarget once", async (t) => {
  const { client, core } = await prepared(t);
  const setup = await selectSecondTask(client, core);
  const secondId = setup.second.id;
  failStoreAdd(t, client.use.database(), "pendingSelectedTasks", "injected selection write failure");
  assert.equal(await client.use.issueSelectedTaskOperation(secondId), false);
  t.mock.restoreAll();
  assert.equal(await client.use.issueSelectedTaskOperation(secondId), true, client.notices.join("; "));
  const after = await dump(client.use.database());
  assert.equal(selectedFor(after, secondId).length, 1);
  const retargets = retargetsFor(after);
  assert.equal(retargets.length, 1);
  assert.equal(retargets[0].timerId, setup.start.timerId);
  assert.equal(retargets[0].taskId, secondId);
  assert.equal(retargets[0].phase, "focus");
  assert.equal(retargets[0].plannedDurationMs, setup.start.plannedDurationMs);
  assert.deepEqual(after.pending.find((command) => command.id === setup.start.id), setup.start);
  assert.ok(after.pending.findIndex((command) => command.id === setup.start.id)
    < after.pending.findIndex((command) => command.id === retargets[0].id));
  assert.equal(await client.use.issueSelectedTaskOperation(secondId), false);
  const repeated = await dump(client.use.database());
  assert.equal(selectedFor(repeated, secondId).length, 1);
  assert.equal(retargetsFor(repeated).length, 1);
});

test("R43-S04 restart replays the exact selection and retarget claim", async (t) => {
  const { client, core, open } = await prepared(t);
  const setup = await selectSecondTask(client, core);
  assert.equal(await client.use.issueSelectedTaskOperation(setup.second.id), true, client.notices.join("; "));
  const saved = await dump(client.use.database());
  const reopened = await open();
  await reopened.use.reloadPersistedState();
  assert.deepEqual(await dump(reopened.use.database()), saved);
  assert.equal(reopened.state.selectedTaskId, setup.second.id);
  assert.equal(reopened.state.timer.taskId, setup.second.id);
  assert.equal(retargetsFor(saved).length, 1);
});

test("R43-S04 same-choice retry on retained selection without retarget exposes recovery", async (t) => {
  const { client, core, open } = await prepared(t);
  const setup = await selectSecondTask(client, core);
  const secondId = setup.second.id;
  assert.equal(await client.use.issueSelectedTaskOperation(secondId), true, client.notices.join("; "));
  const committed = await dump(client.use.database());
  const retarget = retargetsFor(committed)[0];
  await dropRetarget(client.use.database(), committed, retarget.id);
  const reopened = await open();
  await reopened.use.reloadPersistedState();
  assert.equal(reopened.state.selectedTaskId, secondId);
  assert.equal(reopened.state.timer.taskId, setup.firstId);
  const reports = [];
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push(operation) };
  try {
    assert.equal(await reopened.use.issueSelectedTaskOperation(secondId), false);
  } finally {
    delete globalThis.PomodoroughSentryClient;
  }
  assert.match(reopened.notices.at(-1) || "", /previous task/);
  assert.ok(reports.includes("actions.selected-task.retarget-missing"));
  const retained = await dump(reopened.use.database());
  assert.deepEqual(retargetsFor(retained), []);
  assert.equal(reopened.state.timer.taskId, setup.firstId);
});

async function dropRetarget(database, records, retargetId) {
  const transaction = database.transaction(["pending", "meta"], "readwrite");
  transaction.objectStore("pending").delete(retargetId);
  const projection = meta(records, "projectionPending");
  transaction.objectStore("meta").put({ key: "projectionPending",
    value: { ...projection, commands: projection.commands.filter((command) => command.id !== retargetId) } });
  const observation = meta(records, "workspaceObservation");
  const commandTimes = { ...(observation?.commandTimes || {}) };
  delete commandTimes[retargetId];
  transaction.objectStore("meta").put({ key: "workspaceObservation",
    value: { ...(observation || {}), commandTimes } });
  await storage.transactionDone(transaction);
}
