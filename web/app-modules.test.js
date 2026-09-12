"use strict";

const test = require("node:test");
const incarnationFixture = require("./test/incarnation-fixture.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const runtimeHost = require("./app-runtime.js");

const moduleFiles = [
  "app-state.js", "app-storage.js", "app-actions.js", "app-sync.js",
  "app-bootstrap.js", "app-session.js", "app-view.js"
];
const browserModules = moduleFiles.map((file) => require(`./${file}`));

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("browser responsibility modules form one validated dependency graph", () => {
  const externals = {
    host: { document: {} }, elements: {},
    syncCore: { compareTimerCommands: () => 0 }, syncStorage: {},
    sharedCoreHost: {}, translations: {}
  };
  const builder = runtimeHost.createRuntime({ state: {}, externals });
  builder.install({ manifest: { name: "startup", provides: ["resumeStartup"] },
    create: () => ({ resumeStartup: async () => true }) });
  for (const browserModule of browserModules) builder.install(browserModule);
  const graph = builder.finalize().describe();
  assert.deepEqual(graph.map(({ name }) => name), [
    "startup", "state", "storage", "actions", "sync", "bootstrap", "session", "view"
  ]);
  const providers = new Map();
  for (const manifest of graph) {
    for (const action of manifest.provides) providers.set(action, manifest.name);
  }
  for (const manifest of graph) {
    for (const dependency of manifest.requires) {
      assert.ok(providers.has(dependency), `${manifest.name} requires missing ${dependency}`);
      assert.notEqual(providers.get(dependency), manifest.name, `${manifest.name} declares itself as dependency`);
    }
  }
});

test("browser runtime validates revision events at module boundaries", () => {
  const revisions = [];
  const listener = {
    manifest: {
      name: "listener", externals: [], requires: [], provides: ["revisions"],
      emits: [], listens: ["revision-hint"]
    },
    create({ listen }) {
      listen("revision-hint", (event) => revisions.push(event.revision));
      return { revisions: () => revisions };
    }
  };
  const emitter = {
    manifest: {
      name: "emitter", externals: [], requires: [], provides: ["sendRevision"],
      emits: ["revision-hint"], listens: []
    },
    create({ emit }) {
      return { sendRevision: (revision) => emit("revision-hint", { revision }) };
    }
  };
  const builder = runtimeHost.createRuntime({ state: {}, externals: {} });
  builder.install(listener);
  builder.install(emitter);
  const runtime = builder.finalize();
  runtime.call("sendRevision", 7);
  runtime.call("sendRevision", null);
  assert.deepEqual(revisions, [7, null]);
  assert.throws(() => runtime.call("sendRevision", "7"), /Invalid revision-hint event/);
});

test("browser runtime fails closed on undeclared or unavailable dependencies", () => {
  const missing = {
    manifest: {
      name: "missing", externals: [], requires: ["absent"], provides: ["ready"],
      emits: [], listens: []
    },
    create() { return { ready: () => true }; }
  };
  const builder = runtimeHost.createRuntime({ state: {}, externals: {} });
  builder.install(missing);
  assert.throws(() => builder.finalize(), /missing dependency is unavailable: absent/);
  assert.throws(() => runtimeHost.validateManifest({ name: "bad", provides: ["x", "x"] }),
    /contains duplicates/);
});

test("composition facade contains wiring while deep modules own side effects and policy adapters", () => {
  const composition = source("app.js");
  const storage = source("app-storage.js");
  const state = source("app-state.js");
  const sync = source("app-sync.js");
  const bootstrap = source("app-bootstrap.js");
  const session = source("app-session.js");
  const view = source("app-view.js");
  assert.doesNotMatch(composition, /indexedDB\.(?:open|deleteDatabase)|\.transaction\(|new host\.EventSource/);
  assert.doesNotMatch(composition, /\/api\/v1\/(?:sync|me|bootstrap|account|auth)/);
  assert.doesNotMatch(composition, /state\.(?:authenticated|csrfToken|sessionIdentityValidated)\s*=/);
  assert.doesNotMatch(composition, /call\(application, "clearLocalData"\)/);
  assert.doesNotMatch(composition, /\.textContent\s*=|\.hidden\s*=/);
  assert.match(storage, /this\.host\.indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(state, /this\.syncStorage\.projectState\(/);
  assert.match(sync, /this\.syncStorage\.reconcileState\(/);
  assert.match(bootstrap, /this\.syncStorage\.bootstrapPlan\(/);
  assert.match(bootstrap, /this\.syncStorage\.validatePendingForSend\(/);
  assert.match(session, /new this\.host\.EventSource\("\/api\/v1\/stream"\)/);
  assert.match(session, /"\/api\/v1\/(?:me|account|auth\/logout)"/);
  assert.match(session, /async clearPendingLogoutData\(identity\)/);
  assert.match(session, /async initializeSession\(\)/);
  assert.match(view, /document\.createElement\(/);
  assert.match(view, /renderDeviceMark\(\)/);
});

test("responsibility modules expose bounded class composition without blanket exceptions", () => {
  const expectedClasses = new Map([
    ["app-state.js", ["LanguageCatalog", "TrustedClock", "SharedTaskCore", "OwnerStateProjector"]],
    ["app-storage.js", ["DatabaseConnection", "LocalStateRepository", "MutationRepository"]],
    ["app-actions.js", ["CompletionPlanPolicy", "ActionMutations", "TimerLifecycle"]],
    ["app-sync.js", ["SyncResponseReconciler", "SyncCoordinator"]],
    ["app-bootstrap.js", ["BootstrapSubmission", "BootstrapPreparation"]],
    ["app-session.js", ["RevisionStream", "SessionLifecycle"]],
    ["app-view.js", ["PreferenceView", "TimerView", "ActivityView", "AccountView", "ViewEventInstaller"]]
  ]);
  for (const [file, classes] of expectedClasses) {
    const moduleSource = source(file);
    assert.doesNotMatch(moduleSource, /size-exception:/, `${file} must not blanket-exempt composition`);
    for (const className of classes) {
      assert.match(moduleSource, new RegExp(`class ${className}\\b`), `${file} must own ${className}`);
    }
  }
});

test("completion phase decisions cross the typed storage-owned SharedCore seam", () => {
  const actions = source("app-actions.js");
  assert.doesNotMatch(actions, /class TimerPhasePolicy\b/);
  assert.match(actions, /syncStorage\.finishAppliedPlan\(/);
  assert.doesNotMatch(actions, /completedFocusRounds\s*%\s*4|projectedHistory\s*=|nextBreakPhase\(/);
});

test("state collaborators isolate mutable language catalogs per runtime", () => {
  const createActions = () => browserModules[0].create({
    state: {},
    external: {
      host: {}, sharedCoreHost: {}, syncStorage: {},
      syncCore: { compareTimerCommands: () => 0 }
    },
    use: {}
  });
  const first = createActions();
  const second = createActions();
  first.setI18nForTest({ t: (key) => `first:${key}` });
  second.setI18nForTest({ t: (key) => `second:${key}` });
  assert.equal(first.tr("phase.focus"), "first:phase.focus");
  assert.equal(second.tr("phase.focus"), "second:phase.focus");
});

test("revision stream reuses one bound callback and isolates streams per runtime", () => {
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
  }
  const createActions = (emit) => browserModules[5].create({
    state: { sessionIdentityValidated: true, authenticated: true, user: incarnationFixture.accountUser("user-1") },
    external: {
      host: { EventSource: FakeEventSource, navigator: { onLine: true } },
      syncCore: incarnationFixture.sync, syncStorage: {}, elements: {}
    },
    use: { needsBootstrapResolution: () => false }, emit
  });
  const revisions = [];
  const first = createActions((name, value) => revisions.push([name, value]));
  const second = createActions(() => {});
  first.openRevisionStream();
  second.openRevisionStream();
  assert.equal(streams[0].url, "/api/v1/stream");
  assert.strictEqual(streams[0].onmessage, streams[0].listeners.get("revision"));
  assert.notStrictEqual(streams[0].onmessage, streams[1].onmessage);
  streams[0].onmessage({ data: '{"revision":12}' });
  assert.deepEqual(revisions, [["revision-hint", { revision: 12 }]]);
});

test("HTML loads declared modules before composition and service worker caches each asset", () => {
  const html = source("app.html");
  const worker = source("sw.js");
  let priorIndex = -1;
  const scriptVersions = {
    "app.js": 38,
    "app-state.js": 2,
    "app-storage.js": 2,
    "app-actions.js": 4, "app-sync.js": 2, "app-bootstrap.js": 3,
    "app-session.js": 3, "app-view.js": 3
  };
  for (const file of ["app-runtime.js", ...moduleFiles, "app.js"]) {
    const version = scriptVersions[file] || 1;
    const asset = `/${file}?v=${version}`;
    const index = html.indexOf(asset);
    assert.ok(index > priorIndex, `${asset} must load after its dependencies`);
    assert.match(worker, new RegExp(`"${asset.replace(/[.?]/g, "\\$&")}"`));
    priorIndex = index;
  }
});
