"use strict";

const crypto = require("node:crypto");
const sync = require("../sync-core.js");
const storage = require("../sync-storage.js");
const stateModule = require("../app-state.js");

function accountUser(id, generation = 1) {
  if (id === null) return null;
  return { id, accountIncarnation: crypto.createHash("sha256").update(`fixture:${id}:${generation}`).digest("hex") };
}

function ownerId(id, generation = 1) {
  return sync.accountOwnerId(accountUser(id, generation));
}

function captureAccountContext(state, host = {}) {
  return stateModule.create({ state, external: { host, syncCore: sync, syncStorage: storage }, use: {} })
    .captureAccountContext();
}

module.exports = { accountUser, ownerId, captureAccountContext, sync, storage };
