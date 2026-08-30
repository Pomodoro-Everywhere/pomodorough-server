"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, nowMs, user, fixture, seedMeta, dump, meta,
  startFocus, completionInput, project, assertBatch
} = require("./test/p222-completion-fixture.js");

const refusals = [
  {
    name: "stale timer identity", reason: "stale",
    prepare: async (client, input) => { input.timerId = "p222-stale-timer"; }
  },
  {
    name: "live foreign owner", reason: "not_owner",
    prepare: async (client, input) => {
      Object.assign(input, { manual: false, requireOwner: true, observedElapsedMs: 1_500_000 });
      await seedMeta(client.use.database(), { timerOwner: {
        timerId: input.timerId, deviceId: "p222-foreign-device", tabId: "p222-foreign-tab",
        leaseExpiresAtMs: nowMs + 30_000
      } });
    }
  },
  {
    name: "early automatic completion", reason: "stale",
    prepare: async (client, input) => { Object.assign(input, { manual: false, requireOwner: true }); }
  },
  {
    name: "peer paused automatic completion", reason: "stale",
    prepare: async (client, input) => {
      assert.equal(await client.use.issueCommand("pause"), true);
      Object.assign(input, { manual: false, requireOwner: true, nowMs: nowMs + 1_500_000 });
    }
  },
  {
    name: "durable account replacement", error: "AccountOwnershipError",
    prepare: async (client) => {
      const before = await dump(client.use.database());
      await seedMeta(client.use.database(), { snapshot: {
        ...meta(before, "snapshot"), user: { ...user, accountIncarnation: "d".repeat(64) }
      } });
    }
  },
  {
    name: "captured session replacement", error: "AccountOwnershipError",
    prepare: async (client) => { client.state.user = { ...user, accountIncarnation: "d".repeat(64) }; }
  },
  ...["bootstrapGate", "bootstrapResolution"].map((key) => ({
    name: key, error: "BootstrapGateError",
    prepare: async (client) => { await seedMeta(client.use.database(), { [key]: { token: "p222-peer" } }); }
  }))
];

function interceptCompletionWrites(context, database, mode, written) {
  const createTransaction = database.transaction.bind(database);
  context.mock.method(database, "transaction", (names, access) => {
    const transaction = createTransaction(names, access);
    if (access !== "readwrite") return transaction;
    const pending = transaction.objectStore("pending");
    const add = pending.add.bind(pending);
    context.mock.method(pending, "add", (command) => {
      written.push(structuredClone(command));
      const request = add(command);
      if (command.generatedBreak) {
        if (mode === "abort") transaction.abort();
        else add(command);
      }
      return request;
    });
    return transaction;
  });
}

async function assertStaleCompletion(database, input, expected) {
  assert.deepEqual(await storage.finishTimer(database, input), {
    transitioned: false, reason: "stale", commands: []
  });
  assert.deepEqual(await dump(database), expected);
}

async function persistNaturalExpiry(database, core, atMs) {
  const before = await dump(database);
  const expired = project(core, before, atMs);
  assert.equal(expired.canonicalTimer.status, "completed");
  assert.equal(expired.canonicalTimer.lastIntent.type, "start");
  const transaction = database.transaction(["meta", "pending"], "readwrite");
  transaction.objectStore("meta").put({ key: "snapshot", value: {
    ...meta(before, "snapshot"), canonicalTimer: expired.canonicalTimer,
    history: expired.history.filter((entry) => entry.timerId !== expired.canonicalTimer.id)
  } });
  transaction.objectStore("pending").clear();
  await storage.transactionDone(transaction);
}

for (const withUuidV7 of [false, true]) {
  for (const refusal of refusals) {
    test(`P222 ${refusal.name} refuses completion without writes, UUIDv7=${withUuidV7}`, async (context) => {
      const { client } = await fixture(context, { autoStartBreaks: true });
      await startFocus(client);
      const input = completionInput(client, withUuidV7);
      await refusal.prepare(client, input);
      const before = await dump(client.use.database());
      if (refusal.error) {
        await assert.rejects(storage.finishTimer(client.use.database(), input), { name: refusal.error });
      } else {
        const outcome = await storage.finishTimer(client.use.database(), input);
        assert.equal(outcome.transitioned, false);
        assert.equal(outcome.reason, refusal.reason);
        assert.deepEqual(outcome.commands, []);
      }
      assert.deepEqual(await dump(client.use.database()), before);
    });
  }

  for (const mode of ["abort", "duplicate-key"]) {
    test(`P222 storage ${mode} rolls back finish, generated start and reservations, UUIDv7=${withUuidV7}`, async (context) => {
      const { client, open } = await fixture(context, { autoStartBreaks: true });
      await startFocus(client);
      assert.equal(await client.use.issueDurationOperation("short_break", 600_000), true);
      const before = await dump(client.use.database());
      const written = [];
      interceptCompletionWrites(context, client.use.database(), mode, written);
      await assert.rejects(storage.finishTimer(client.use.database(), completionInput(client, withUuidV7)));
      assert.deepEqual(written.map((command) => command.type), ["finish", "start"]);
      assert.equal(written[1].dependsOnCommandId, written[0].id);
      assert.equal(written[1].plannedDurationMs, 600_000);
      assert.deepEqual(await dump(client.use.database()), before);
      client.use.database().close();
      const restarted = await open();
      assert.deepEqual(await dump(restarted.use.database()), before);
    });
  }

  test(`P222 real Core rejects malformed generated timer atomically, UUIDv7=${withUuidV7}`, async (context) => {
    const { client } = await fixture(context, { autoStartBreaks: true });
    await startFocus(client);
    const before = await dump(client.use.database());
    await assert.rejects(storage.finishTimer(client.use.database(), completionInput(client, withUuidV7, {
      breakTimerId: ""
    })), { name: "Error", message: "invalid shared-core input: invalid timer command" });
    assert.deepEqual(await dump(client.use.database()), before);
  });

  test(`P222 late Core failure leaves no finish or reservations, UUIDv7=${withUuidV7}`, async (context) => {
    const { client, core } = await fixture(context, { autoStartBreaks: true });
    await startFocus(client);
    const before = await dump(client.use.database());
    let projections = 0;
    const failingCore = {
      tickHlc: core.tickHlc.bind(core), planTimerCompletion: core.planTimerCompletion.bind(core),
      projectSynchronizedState(input) {
        projections += 1;
        if (projections === 3) throw new Error("P222 late Core failure");
        return core.projectSynchronizedState(input);
      }
    };
    await assert.rejects(storage.finishTimer(client.use.database(), completionInput(client, withUuidV7, {
      sharedCore: failingCore
    })), /P222 late Core failure/);
    assert.equal(projections, 3);
    assert.deepEqual(await dump(client.use.database()), before);
  });

  test(`P222 generated timer finish retains source dependency, UUIDv7=${withUuidV7}`, async (context) => {
    const { client, core } = await fixture(context, { autoStartBreaks: true });
    await startFocus(client);
    const first = await storage.finishTimer(client.use.database(), completionInput(client, withUuidV7));
    await client.use.reloadPersistedState();
    const input = completionInput(client, withUuidV7, { finishCommandId: "p222-finish-break" });
    delete input.requestedTimer;
    const before = await dump(client.use.database());
    const second = await storage.finishTimer(client.use.database(), input);
    assert.equal(second.transitioned, true);
    assert.equal(second.commands.length, 1);
    assert.equal(second.commands[0].dependsOnCommandId, first.commands[0].id);
    const after = await dump(client.use.database());
    assertBatch(before, after, { ...input, requestedTimer: client.state.timer }, second);
    assert.equal(project(core, after).canonicalTimer.status, "completed");
  });

  test(`P222 newer snapshot preferences and local settings beat captured input, UUIDv7=${withUuidV7}`, async (context) => {
    const { client } = await fixture(context);
    await startFocus(client);
    const input = completionInput(client, withUuidV7);
    input.settings.staleOnlySetting = "must not resurrect";
    const captured = await dump(client.use.database());
    const previous = meta(captured, "snapshot");
    await seedMeta(client.use.database(), {
      snapshot: { ...previous, autoStartBreaks: true, durationsMs: { ...previous.durationsMs, short_break: 900_000 } },
      settings: { ...meta(captured, "settings"), peerOnlySetting: "preserve" }
    });
    const before = await dump(client.use.database());
    const outcome = await storage.finishTimer(client.use.database(), input);
    assert.equal(outcome.commands.length, 2);
    assert.equal(outcome.commands[1].plannedDurationMs, 900_000);
    const after = await dump(client.use.database());
    assertBatch(before, after, input, outcome);
    assert.equal(meta(after, "settings").peerOnlySetting, "preserve");
    assert.equal(meta(after, "settings").staleOnlySetting, undefined);
  });

  test(`P222 peer-disabled concurrent captured Finish preserves first provenance, UUIDv7=${withUuidV7}`, async (context) => {
    const { client, core, open } = await fixture(context, { autoStartBreaks: true });
    await startFocus(client);
    const firstInput = completionInput(client, withUuidV7);
    const peer = await open();
    await peer.use.reloadPersistedState();
    const secondInput = completionInput(peer, withUuidV7, { finishCommandId: "p222-second-finish" });
    for (const input of [firstInput, secondInput]) {
      assert.equal(input.autoStartBreaks, true);
      input.settings.staleOnlySetting = "must not resurrect";
    }
    assert.equal(await peer.use.issueAutoStartOperation(false), true);
    await seedMeta(peer.use.database(), { settings: { selectedPhase: "focus", peerOnlySetting: "preserve" } });
    const before = await dump(client.use.database());
    assert.equal(project(core, before).autoStartBreaks, false);
    const outcomes = await Promise.all([
      storage.finishTimer(client.use.database(), firstInput),
      storage.finishTimer(peer.use.database(), secondInput)
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.transitioned).length, 1);
    assert.deepEqual(outcomes.find((outcome) => !outcome.transitioned), {
      transitioned: false, reason: "stale", commands: []
    });
    const winnerIndex = outcomes.findIndex((outcome) => outcome.transitioned);
    const winner = outcomes[winnerIndex];
    assert.equal(winner.commands.length, 1);
    const after = await dump(client.use.database());
    assertBatch(before, after, [firstInput, secondInput][winnerIndex], winner);
    const projection = project(core, after);
    assert.equal(projection.canonicalTimer.id, firstInput.timerId);
    assert.equal(projection.canonicalTimer.lastIntent.commandId, winner.commands[0].id);
    assert.equal(projection.history.find((entry) => entry.timerId === firstInput.timerId).commandId, winner.commands[0].id);
    assert.deepEqual(meta(after, "settings"), { selectedPhase: winner.selectedPhase, peerOnlySetting: "preserve" });
    const repeated = { ...secondInput, finishCommandId: "p222-repeated-finish" };
    await assertStaleCompletion(peer.use.database(), repeated, after);
    client.use.database().close();
    peer.use.database().close();
    const reopened = await open();
    assert.deepEqual(await dump(reopened.use.database()), after);
    await assertStaleCompletion(reopened.use.database(), repeated, after);
  });

  for (const manual of [false, true]) {
    test(`P222 naturally expired canonical timer permits one explicit Finish, manual=${manual}, UUIDv7=${withUuidV7}`, async (context) => {
      const { client, core, open } = await fixture(context);
      await startFocus(client);
      const input = completionInput(client, withUuidV7, {
        manual, requireOwner: !manual, nowMs: nowMs + 1_500_000, observedElapsedMs: 1_500_000
      });
      await persistNaturalExpiry(client.use.database(), core, input.nowMs);
      const before = await dump(client.use.database());
      const natural = project(core, before, input.nowMs);
      assert.equal(natural.canonicalTimer.status, "completed");
      assert.equal(natural.canonicalTimer.lastIntent.type, "start");
      assert.equal(natural.history.find((entry) => entry.timerId === input.timerId).commandId,
        natural.canonicalTimer.lastIntent.commandId);
      const outcome = await storage.finishTimer(client.use.database(), input);
      assert.equal(outcome.transitioned, true);
      assert.equal(outcome.commands.length, 1);
      const after = await dump(client.use.database());
      assertBatch(before, after, input, outcome);
      const finished = project(core, after, input.nowMs);
      assert.equal(finished.canonicalTimer.id, input.timerId);
      assert.equal(finished.canonicalTimer.lastIntent.type, "finish");
      assert.equal(finished.canonicalTimer.lastIntent.commandId, outcome.commands[0].id);
      assert.equal(finished.history.find((entry) => entry.timerId === input.timerId).commandId, outcome.commands[0].id);
      await assertStaleCompletion(client.use.database(), { ...input, finishCommandId: "p222-repeat-natural" }, after);
      client.use.database().close();
      const reopened = await open();
      assert.deepEqual(await dump(reopened.use.database()), after);
      await assertStaleCompletion(reopened.use.database(), input, after);
    });
  }
}
