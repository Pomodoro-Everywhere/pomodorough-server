"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const accountOperation = require("./account-operation.js");

const source = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

function method(file, name) {
  const text = source(file);
  const start = text.search(new RegExp(`^    (?:async )?${name}\\(`, "m"));
  assert.notEqual(start, -1, `${file}:${name}`);
  const next = text.slice(start + 1).search(/^    (?:async )?[a-zA-Z]\w*\(/m);
  return text.slice(start, next === -1 ? text.length : start + 1 + next);
}

test("account continuation contracts require branded context without recapturing issuer", () => {
  const contracts = {
    "app-session.js": { applySessionPayload: "payload, context", fetchSessionPayload: "context", refreshMutationCsrf: "expectedUserId, context",
      postMutation: "url, body, expectedUserId, context", restoreSessionAndSync: "context",
      validateSessionBinding: "binding, context, sequence", requestAccountDeletion: "confirmation, context",
      requestSessionRevocation: "csrfToken, ownerId, context", clearPendingLogoutData: "identity, issuer" },
    "app-bootstrap.js": { acceptBootstrapResponse: "payload, pending, timing, context",
      sendBootstrapResolution: "pending, context", validateBootstrapSubmission: "pending, context",
      recoverInvalidBootstrapSubmission: "context", resumeNormalSyncFromBootstrap: "persisted, context",
      reconcileBootstrapAccount: "context", acquireBootstrapPreparationGate: "context",
      submitMatchingBootstrapResolution: "context", reconcilePersistedBootstrapState: "context",
      prepareBootstrapPlan: "context", persistAutomaticBootstrapResolution: "context", prepareBootstrapOnce: "context" },
    "app-sync.js": { acceptSyncResponse: "payload, sent, expectedUserId, timing, context, capturedClaim" },
    "app-actions.js": { executeWorkspaceEffects: "effects, context" },
    "app-storage.js": { refreshMigratedPreferences: "gate, context" }
  };
  for (const [file, methods] of Object.entries(contracts)) for (const [name, argumentsText] of Object.entries(methods)) {
    const text = method(file, name);
    assert.ok(text.startsWith(`    async ${name}(${argumentsText}) {`) || text.startsWith(`    ${name}(${argumentsText}) {`),
      `${file}:${name} must require issuing context`);
    assert.match(text, /accountOperation\.(?:requireBound|isCurrent)\((?:context|issuer)\)/);
    assert.doesNotMatch(text, /captureAccountContext\(/, `${file}:${name} must not renew issuer`);
  }
});

test("PWA mutation, session retry and clock entrypoints retain explicit operation context", () => {
  const bootstrap = source("app-bootstrap.js");
  const session = source("app-session.js");
  const sync = source("app-sync.js");
  const production = fs.readdirSync(__dirname).filter((name) => /^app(?:-[\w-]+)?\.js$/.test(name))
    .map(source).join("\n");
  const mutations = [...production.matchAll(/\.postMutation\(([\s\S]*?)\);/g)];
  assert.equal(mutations.length, 2, "all PWA mutation transports must be audited");
  for (const [, argumentsText] of mutations) assert.match(argumentsText, /, context\s*$/);
  assert.match(sync, /restoreSessionAndSync\(context\)/);
  assert.doesNotMatch(production, /restoreSessionAndSync\(\)/);
  assert.doesNotMatch(production, /fetchSessionPayload\(\)/);
  assert.match(session, /fetchSessionPayload\(context\)/);
  assert.match(session, /refreshMutationCsrf\(expectedUserId, context\)/);
  assert.match(session, /allocateClockRequestSequence\(this\.use\.database\(\), context\)/);
  assert.match(bootstrap, /allocateClockRequestSequence\(this\.use\.database\(\), context\);\s*context\.assertCurrent\(\)/);
  assert.match(method("app-session.js", "loadSession"), /fetchSessionPayload\(context\);\s*const completed = this\.sessionCompletionContexts\.get\(context\) \|\| context;\s*completed\.assertCurrent\(\)/);
  assert.match(method("app-bootstrap.js", "acceptBootstrapResponse"), /reloadPersistedState\(null, context\);\s*context\.assertCurrent\(\)/);
  assert.match(method("app-bootstrap.js", "acceptBootstrapResponse"), /render\(\);\s*context\.assertCurrent\(\);\s*this\.use\.openRevisionStream\(context\)/);
  assert.match(method("app-session.js", "restoreSessionAndSync"), /stream\.openRevisionStream\(context\)/);
  assert.match(method("app-state.js", "captureAccountContext"), /\(\) => this\.use\.database\(\)/);
  assert.doesNotMatch(method("app-state.js", "captureAccountContext"), /database\?\./);
});

test("account operation is shipped before state capture in HTML and offline shell", () => {
  const html = source("app.html");
  const worker = source("sw.js");
  for (const text of [html, worker]) {
    assert.ok(text.indexOf("account-operation.js?v=1") >= 0);
    assert.ok(text.indexOf("account-operation.js?v=1") < text.indexOf("app-state.js"));
  }
});

test("identity publication advances only identity on original connection", () => {
  class AccountOwnershipError extends Error { constructor() { super(); this.name = "AccountOwnershipError"; } }
  let database = {};
  let ownerId = null;
  const identity = () => {
    const issued = ownerId;
    return { ownerId: issued, assertCurrent() { if (ownerId !== issued) throw new AccountOwnershipError(); } };
  };
  const context = accountOperation.bind(identity(), () => database, AccountOwnershipError, identity);
  context.publishIdentity(() => { ownerId = "authenticated"; });
  assert.equal(context.ownerId, "authenticated");
  assert.equal(accountOperation.requireBound(context), context);
  database = {};
  assert.equal(accountOperation.isCurrent(context), false);
  assert.throws(() => context.publishIdentity(() => { ownerId = "replacement"; }), AccountOwnershipError);
  assert.equal(ownerId, "authenticated");
  assert.throws(() => accountOperation.requireBound({ ...context }), TypeError);
});

test("validated account handoff never renews old owner callbacks on same connection", () => {
  class AccountOwnershipError extends Error { constructor() { super(); this.name = "AccountOwnershipError"; } }
  const database = {};
  let ownerId = "old";
  const identity = () => {
    const issued = ownerId;
    return { ownerId: issued, assertCurrent() { if (ownerId !== issued) throw new AccountOwnershipError(); } };
  };
  const context = accountOperation.bind(identity(), () => database, AccountOwnershipError, identity);
  const next = context.publishIdentity(() => { ownerId = "new"; });
  assert.notEqual(next, context);
  assert.equal(context.ownerId, "old");
  assert.equal(next.ownerId, "new");
  assert.equal(accountOperation.isCurrent(context), false);
  assert.equal(accountOperation.isCurrent(next), true);
});
