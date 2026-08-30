"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, sync, nowMs, fixture, seedMeta, seedQueues, dump, meta,
  startFocus, completionInput, completedFocusHistory, project, assertBatch
} = require("./test/p222-completion-fixture.js");

for (const phase of ["short_break", "long_break"]) {
  test(`P222 actual offline actions preserve queued ${phase} duration through reopen`, async (context) => {
    const { client, core, open } = await fixture(context, {
      history: phase === "long_break" ? completedFocusHistory() : []
    });
    assert.equal(await client.use.issueAutoStartOperation(true), true);
    const durationMs = phase === "long_break" ? 1_800_000 : 600_000;
    assert.equal(await client.use.issueDurationOperation(phase, durationMs), true);
    await startFocus(client);
    const before = await dump(client.use.database());
    assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
    const after = await dump(client.use.database());
    const generated = after.pending.find((command) => command.generatedBreak);
    assert.equal(generated.phase, phase);
    assert.equal(generated.plannedDurationMs, durationMs);
    assert.equal(client.state.timer.plannedDurationMs, durationMs);
    for (const store of ["pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"]) {
      assert.deepEqual(after[store], before[store]);
    }
    client.use.database().close();
    const restarted = await open();
    await restarted.use.reloadPersistedState();
    assert.deepEqual(await dump(restarted.use.database()), after);
    assert.equal(restarted.state.timer.plannedDurationMs, durationMs);
    assert.equal(project(core, after).durationsMs[phase], durationMs);
  });
}

async function peerPreferences(peer, core, phase, enabled) {
  await peer.use.reloadPersistedState();
  assert.equal(await peer.use.issueAutoStartOperation(enabled), true);
  assert.equal(await peer.use.issueDurationOperation(phase, 1_200_000), true);
  const identity = core.taskIdentity({ title: "P222 peer task" });
  assert.equal(await peer.use.issueTaskOperation("upsert", identity), true);
  assert.equal(await peer.use.issueSelectedTaskOperation(identity.id), true);
  await seedMeta(peer.use.database(), { settings: {
    selectedPhase: "long_break", durationSyncBootstrapped: true, autoStartSyncBootstrapped: true,
    selectedTaskSyncBootstrapped: true, peerOnlySetting: "preserve"
  } });
  return identity;
}

async function assertReopened(open, client, after, core, input, outcome, identity) {
  const projection = project(core, after, input.nowMs);
  assert.equal(projection.selectedTaskId, identity.id);
  assert.equal(projection.tasks.find((task) => task.id === identity.id).title, identity.title);
  if (outcome.commands.length === 2) {
    assert.equal(projection.canonicalTimer.plannedDurationMs, 1_200_000);
    assert.equal(meta(after, "timerOwner").timerId, input.breakTimerId);
  }
  assert.equal(meta(after, "settings").peerOnlySetting, "preserve");
  assert.equal(meta(after, "settings").selectedPhase, outcome.selectedPhase);
  const batch = sync.buildSyncBatch(await storage.readQueues(client.use.database()));
  assert.ok(batch.commands.some((command) => command.id === outcome.commands[0].id));
  assert.ok(!batch.commands.some((command) => command.generatedBreak));
  client.use.database().close();
  const reopened = await open();
  assert.deepEqual(await dump(reopened.use.database()), after);
  assert.deepEqual(sync.buildSyncBatch(await storage.readQueues(reopened.use.database())), batch);
}

for (const withUuidV7 of [false, true]) {
  for (const phase of ["short_break", "long_break"]) {
    for (const automatic of [false, true]) {
      for (const enabled of [false, true]) {
        test(`P222 peer queues govern ${phase}, auto=${enabled}, automatic=${automatic}, UUIDv7=${withUuidV7}`, async (context) => {
          const { client, core, open } = await fixture(context, {
            autoStartBreaks: !enabled, history: phase === "long_break" ? completedFocusHistory() : []
          });
          await startFocus(client);
          const input = completionInput(client, withUuidV7, {
            manual: !automatic, requireOwner: automatic,
            nowMs: automatic ? nowMs + 1_500_000 : nowMs,
            observedElapsedMs: automatic ? 1_500_000 : 0
          });
          const peer = await open();
          const identity = await peerPreferences(peer, core, phase, enabled);
          const before = await dump(client.use.database());
          const outcome = await storage.finishTimer(client.use.database(), input);
          assert.equal(outcome.transitioned, true);
          assert.equal(outcome.selectedPhase, phase);
          assert.equal(outcome.selectedPhaseDurationMs, 1_200_000);
          assert.equal(outcome.commands.length, enabled ? 2 : 1);
          const after = await dump(client.use.database());
          assertBatch(before, after, input, outcome);
          await assertReopened(open, client, after, core, input, outcome, identity);
        });
      }
    }
  }
}

for (const withUuidV7 of [false, true]) {
  test(`P222 every completion projection receives complete transaction queues, UUIDv7=${withUuidV7}`, async (context) => {
    const { client, core, open } = await fixture(context);
    await startFocus(client);
    const peer = await open();
    await peerPreferences(peer, core, "short_break", true);
    const before = await storage.readQueues(client.use.database());
    const projections = [];
    const observedCore = {
      tickHlc: core.tickHlc.bind(core), planTimerCompletion: core.planTimerCompletion.bind(core)
    };
    observedCore.projectSynchronizedState = (input) => {
      projections.push(structuredClone(input.pending));
      return core.projectSynchronizedState(input);
    };
    const input = completionInput(client, withUuidV7, { sharedCore: observedCore });
    delete input.requestedTimer;
    const outcome = await storage.finishTimer(client.use.database(), input);
    assert.equal(outcome.commands[1].plannedDurationMs, 1_200_000);
    assert.equal(projections.length, 4);
    for (const pending of projections) {
      for (const name of ["taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"]) {
        assert.deepEqual(pending[name], before[name]);
      }
    }
    assert.deepEqual(projections.at(-1).commands, before.commands.concat(outcome.commands));
  });

  test(`P222 repeated and concurrent finish deliveries commit once, UUIDv7=${withUuidV7}`, async (context) => {
    const { client, open } = await fixture(context, { autoStartBreaks: true });
    await startFocus(client);
    const peer = await open();
    const input = completionInput(client, withUuidV7);
    const outcomes = await Promise.all([
      storage.finishTimer(client.use.database(), input), storage.finishTimer(peer.use.database(), input)
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.transitioned).sort(), [false, true]);
    const after = await dump(client.use.database());
    assert.equal(after.pending.filter((command) => command.type === "finish").length, 1);
    assert.equal(after.pending.filter((command) => command.generatedBreak).length, 1);
    assert.equal((await storage.finishTimer(peer.use.database(), input)).transitioned, false);
    assert.deepEqual(await dump(peer.use.database()), after);
  });
}

test("P222 UUIDv7 reservation rejects state behind pending preference identifiers atomically", async (context) => {
  const { client } = await fixture(context, { autoStartBreaks: true });
  await startFocus(client);
  const before = await dump(client.use.database());
  const last = storage.uuid7Parts(meta(before, storage.UUID7_KEY));
  const collisionId = storage.uuid7FromParts(last.timestampMs, last.randomValue + 1n);
  await seedQueues(client.use.database(), { durationOperations: [{
    id: collisionId, deviceId: client.state.deviceId, phase: "short_break", durationMs: 600_000,
    occurredAt: new Date(nowMs).toISOString(), hlcWallMs: nowMs, hlcCounter: 10
  }] });
  const persisted = await dump(client.use.database());
  await assert.rejects(storage.finishTimer(client.use.database(), completionInput(client, true)), {
    name: "UUIDRangeError", message: "Persisted UUIDv7 state predates a pending identifier."
  });
  assert.deepEqual(await dump(client.use.database()), persisted);
});
