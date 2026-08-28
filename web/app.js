(() => {
  "use strict";

  const SINGLE_ELEMENT_IDS = Object.freeze([
    "installButton", "syncStatus", "syncStatusText", "profile", "profileAvatar",
    "logoutButton", "deleteAccountButton", "conflictPanel", "conflictReason",
    "conflictDismiss", "notice", "bootstrapDialog", "bootstrapTitle", "bootstrapSummary",
    "bootstrapChoices", "bootstrapConfirmation", "bootstrapConfirmationTitle",
    "bootstrapConfirmationMessage", "bootstrapConfirm", "bootstrapCancel", "bootstrapError",
    "bootstrapRetry", "bootstrapSignOut", "timerScreen", "tasksScreen", "durationForm",
    "autoStartBreaks", "taskSelector", "dial", "dialTicks", "dialProgress", "phaseLabel",
    "timerDisplay", "timerDetail", "longBreakProgress", "timerInstruction", "timerToggle",
    "finishButton", "cancelButton", "clearButton", "historyList", "historyCount", "taskForm",
    "taskInput", "taskList", "taskCount", "deviceMark"
  ]);
  const MODULE_GLOBALS = Object.freeze([
    "PomodoroughAppState", "PomodoroughAppStorage", "PomodoroughAppActions",
    "PomodoroughAppSync", "PomodoroughAppBootstrap", "PomodoroughAppSession",
    "PomodoroughAppView"
  ]);
  const COMPATIBILITY_ACTIONS = Object.freeze([
    "phaseLabel", "timerStatusLabel", "formatTaskDuration", "formatHistoryDate", "setI18nForTest",
    "emptyTimer", "displayTimer", "elapsedFor", "trustedNow", "responseClockOffset",
    "rebuildOptimisticState", "selectedTaskIdForNextFocus", "refreshAllPendingOperations",
    "renderTaskSelector", "issueSelectedTaskOperation", "ownerStateValue", "resetOwnerState",
    "restoreOwnerState", "activateCachedOwnerOffline", "requestResult", "transactionDone",
    "openDatabase", "readLocalRecords", "restoreLocalRecords", "persistNewLocalIdentity",
    "migrateDurationQueueFromSettings", "bootstrapLegacyDurations", "settingsValue", "snapshotValue",
    "setDatabaseForTest", "completionRetryDelay", "completedFocusCountForDay", "longBreakProgress",
    "nextBreakPhase", "nextPhaseAfterCompletion", "selectedPhaseAfterRejectedFinish",
    "selectedPhaseAfterCommandAcknowledgements", "rejectedSyncAcknowledgements", "arrivalHistoryItems",
    "historyTaskContext", "historyStatusLabel", "renderScreens", "setupScreenNavigation",
    "releaseCompletionRetry", "scheduleCompletionRetry", "setCompletionQueuedForTest",
    "completionQueuedForTest", "closeRevisionStreamForIdentityChange", "openRevisionStream",
    "closeRevisionStream", "pollRemoteState", "remoteSyncIntervalMs", "completionAlertTitle",
    "primeCompletionAlerts", "startCompletionAlert", "stopCompletionAlert", "completionSoundIntervalMs",
    "completionAlertTimerIDTest", "completionAlertDismissedTimerIDTest",
    "accountDeletionConfirmationIsValid", "pendingLocalLogout", "markPendingLogout",
    "clearPendingLogout", "requestSessionRevocation", "deleteAccount", "logout", "clearLocalData",
    "fetchSessionPayload", "loadSession", "applySessionPayload", "refreshMutationCsrf", "syncPreflight",
    "scheduleRetry", "retryDelayMsForTest", "persistBootstrapResolution",
    "restartBootstrapForCurrentAccount", "loadBootstrapPreview", "validateBootstrapSubmission",
    "localBootstrapState", "buildBootstrapPlan", "setFetchForTest", "setStorageMethodForTest",
    "setRevisionStreamForTest", "hasRevisionStreamForTest", "render", "renderTimer", "syncNow",
    "showNotice", "loadLocalState", "loadSharedCore", "setupEvents", "createDialTicks",
    "renderSyncStatus", "heartbeatTimerOwnership", "timerOwnerHeartbeatMs"
  ]);

  function createBrowserHost(root) {
    const page = root.window || root;
    return {
      document: root.document, navigator: root.navigator, indexedDB: root.indexedDB,
      crypto: root.crypto, sessionStorage: root.sessionStorage, localStorage: root.localStorage,
      performance: root.performance, console: root.console, location: page.location,
      Notification: root.Notification, EventSource: root.EventSource,
      AudioContext: root.AudioContext || root.webkitAudioContext,
      fetch: (...args) => root.fetch(...args),
      prompt: (...args) => page.prompt(...args), confirm: (...args) => page.confirm(...args),
      setTimeout: (...args) => page.setTimeout(...args), clearTimeout: (...args) => page.clearTimeout(...args),
      setInterval: (...args) => page.setInterval(...args), clearInterval: (...args) => page.clearInterval(...args),
      addEventListener: (...args) => page.addEventListener(...args)
    };
  }

  function collectElements(document) {
    const elements = Object.fromEntries(SINGLE_ELEMENT_IDS.map(
      (id) => [id, document.querySelector(`#${id}`)]
    ));
    elements.bootstrapChoiceButtons = [...document.querySelectorAll("[data-bootstrap-strategy]")];
    elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
    elements.phaseButtons = [...document.querySelectorAll(".phase-button")];
    elements.durationInputs = [...document.querySelectorAll(".stepper input")];
    elements.stepButtons = [...document.querySelectorAll("[data-step]")];
    return Object.freeze(elements);
  }

  function browserModules(root) {
    return MODULE_GLOBALS.map((name) => {
      const browserModule = root[name];
      if (!browserModule) throw new Error(`Browser module is unavailable: ${name}`);
      return browserModule;
    });
  }

  function createApplication(root) {
    if (!root.PomodoroughAppRuntime) throw new Error("Browser module runtime is unavailable.");
    const host = createBrowserHost(root);
    const state = root.PomodoroughAppState.createState(host);
    const externals = {
      host, elements: collectElements(host.document), syncCore: root.PomodoroughSync,
      syncStorage: root.PomodoroughStorage, sharedCoreHost: root.PomodoroughSharedCore,
      translations: root.PomodoroughI18n
    };
    const builder = root.PomodoroughAppRuntime.createRuntime({ state, externals });
    for (const browserModule of browserModules(root)) builder.install(browserModule);
    return { root, host, state, externals, runtime: builder.finalize() };
  }

  function call(application, name, ...args) {
    return application.runtime.call(name, ...args);
  }

  async function initializeLocalization(application) {
    const { host, externals } = application;
    if (!externals.translations?.loadBrowserI18n) return;
    try {
      call(application, "setI18nForTest", await externals.translations.loadBrowserI18n());
    } catch (error) {
      host.console.warn("Pomodorough localization unavailable; using embedded English:", error);
    }
  }

  async function initializeStorage(application) {
    const { state, externals } = application;
    try {
      externals.syncStorage.setSharedCore(await call(application, "loadSharedCore"));
      await call(application, "loadLocalState");
      state.ready = true;
      call(application, "renderDeviceMark");
      call(application, "render");
      return true;
    } catch (error) {
      call(application, "showNotice", call(application, "tr", "storage.unavailable",
        { error: error.message }, `Durable timer storage unavailable: ${error.message}`));
      call(application, "renderSyncStatus");
      return false;
    }
  }

  async function registerServiceWorker(application) {
    const { host } = application;
    if (!("serviceWorker" in host.navigator)) return;
    try {
      await host.navigator.serviceWorker.register("/sw.js", { scope: "/app" });
    } catch (error) {
      host.console.warn("Pomodorough offline shell unavailable:", error);
    }
  }

  async function initializeApplication(application) {
    await initializeLocalization(application);
    call(application, "createDialTicks");
    call(application, "setupEvents");
    call(application, "render");
    registerServiceWorker(application);
    if (!await call(application, "clearPendingLogoutData")) return;
    if (!await initializeStorage(application)) return;
    await call(application, "initializeSession");
  }

  function applicationOrchestration(application) {
    return Object.freeze({
      initialize: () => initializeApplication(application),
      registerServiceWorker: () => registerServiceWorker(application)
    });
  }

  function exposeFacades(application, orchestration, actions) {
    const { root, state } = application;
    const testConfiguration = root.PomodoroughAppTest;
    root.PomodoroughApp = Object.freeze({
      initialize: orchestration.initialize, render: actions.render, syncNow: actions.syncNow
    });
    if (testConfiguration) {
      root.PomodoroughAppTest = {
        ...actions, state,
        remoteSyncIntervalMs: actions.remoteSyncIntervalMs(),
        completionSoundIntervalMs: actions.completionSoundIntervalMs()
      };
    }
    return testConfiguration?.disableAutoStart === true;
  }

  function startSchedulers(application, actions) {
    const { host, state } = application;
    host.setInterval(() => {
      if (state.ready) actions.renderTimer();
    }, 250);
    host.setInterval(actions.heartbeatTimerOwnership, actions.timerOwnerHeartbeatMs());
    host.setInterval(actions.pollRemoteState, actions.remoteSyncIntervalMs());
  }

  const application = createApplication(globalThis);
  const orchestration = applicationOrchestration(application);
  const actions = application.runtime.facade(COMPATIBILITY_ACTIONS.concat(["tr", "prepareBootstrap"]));
  startSchedulers(application, actions);
  const autoStartDisabled = exposeFacades(application, orchestration, actions);
  if (!autoStartDisabled) orchestration.initialize();
})();
