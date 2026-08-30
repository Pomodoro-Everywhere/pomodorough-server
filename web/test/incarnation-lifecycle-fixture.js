"use strict";

const assert = require("node:assert/strict");
const sessionModule = require("../app-session.js");
const { accountUser, ownerId } = require("./incarnation-fixture.js");
const ownership = require("./account-ownership-fixture.js");
const publicId = "same-google-subject";
const queueNames = ["commands", "taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"];

function canonical(generation, revision = 0) {
  const payload = {
    ...ownership.snapshot(publicId), revision,
    accountIncarnation: accountUser(publicId, generation).accountIncarnation,
    serverHlcWallMs: ownership.nowMs, serverHlcCounter: 0,
    acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [],
    autoStartAcknowledgements: [], selectedTaskAcknowledgements: []
  };
  delete payload.user;
  return payload;
}

function attachSession(current, memory = new Map()) {
  const { host, elements } = current.external;
  host.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)), removeItem: (key) => memory.delete(key)
  };
  host.location = { assign: (url) => current.calls.push(["navigate", url]) };
  host.confirm = () => true;
  host.prompt = () => "DELETE";
  Object.assign(elements, {
    bootstrapChoiceButtons: ["keep_local", "keep_remote", "merge"].map((strategy) => ({ dataset: { bootstrapStrategy: strategy } })),
    bootstrapConfirm: {}, bootstrapRetry: {}, deleteAccountButton: {}, logoutButton: {}
  });
  current.use.renderProfile = () => {};
  Object.assign(current.use, sessionModule.create({
    state: current.state, external: current.external, use: current.use,
    emit: (name, payload) => current.calls.push([name, payload])
  }));
  return memory;
}

function serveIncarnation(current, generation, options = {}) {
  const requests = [];
  current.external.host.fetch = async (url, request = {}) => {
    requests.push({ url, request });
    if (url === "/api/v1/me") return { ok: true, status: 200, json: async () => ({
      user: accountUser(publicId, generation), csrfToken: `csrf-${generation}`
    }) };
    assert.equal(request.headers["X-Pomodorough-Account-Incarnation"], accountUser(publicId, generation).accountIncarnation);
    if (url === "/api/v1/bootstrap") return { ok: true, status: 200, json: async () => canonical(generation) };
    if (url === "/api/v1/bootstrap/resolve") {
      options.onResolve?.(JSON.parse(request.body));
      return { ok: true, status: 200, json: async () => canonical(generation) };
    }
    throw new Error(`Unexpected offline fixture request: ${url}`);
  };
  return requests;
}

async function lifecycle(context, timerStatus = null) {
  const result = await ownership.fixture(context, timerStatus, publicId);
  const { stale, peer } = result;
  const oldSnapshot = { ...ownership.snapshot(publicId, timerStatus), revision: 20 };
  await ownership.seedMeta(stale.use.database(), { snapshot: oldSnapshot });
  peer.state.user = accountUser(publicId);
  peer.state.localOwnerId = ownerId(publicId);
  await Promise.all([stale.use.reloadPersistedState(), peer.use.reloadPersistedState()]);
  const memory = attachSession(stale);
  attachSession(peer, memory);
  return { ...result, memory, oldSnapshot };
}

async function fillQueues(current, core) {
  const task = core.taskIdentity({ title: "Unsent old incarnation work" });
  assert.equal(await current.use.issueTaskOperation("upsert", task), true);
  assert.equal(await current.use.issueDurationOperation("short_break", 600_000), true);
  assert.equal(await current.use.issueAutoStartOperation(false), true);
  assert.equal(await current.use.issueSelectedTaskOperation(task.id), true);
  assert.equal(await current.use.issueCommand(current.state.timer.status === "running" ? "pause" : "start", { phase: "focus" }), true);
  await current.use.reloadPersistedState();
  const queues = await ownership.storage.readQueues(current.use.database());
  for (const name of queueNames) assert.equal(queues[name].length, 1, name);
  return queues;
}

async function discoverRecreation(current) {
  const requests = serveIncarnation(current, 2);
  assert.equal(await current.use.loadSession(), true);
  await current.use.prepareBootstrap();
  assert.equal(current.state.bootstrapPlan.reason, "different_owner");
  assert.equal(current.state.bootstrapPlan.strategy, "keep_remote");
  assert.equal(current.state.bootstrapOwnershipConfirmation, true);
  assert.equal(current.state.bootstrapPending, null);
  return requests;
}

async function confirmRecreation(current) {
  await current.use.chooseBootstrapStrategy("keep_remote", false);
  assert.equal(current.state.bootstrapPending, null);
  await current.use.chooseBootstrapStrategy("keep_remote", true);
  assert.equal(current.state.bootstrapError, null);
  assert.equal(current.state.localOwnerId, ownerId(publicId, 2));
  assert.equal(current.state.revision, 0);
  assert.equal(current.use.controlsBlocked(), false);
}

module.exports = { ...ownership, accountUser, ownerId, publicId, queueNames,
  canonical, attachSession, serveIncarnation, lifecycle, fillQueues, discoverRecreation, confirmRecreation };
