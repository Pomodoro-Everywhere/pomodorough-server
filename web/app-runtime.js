(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EVENT_VALIDATORS = Object.freeze({
    "revision-hint": (value) => value?.revision === null || Number.isFinite(value?.revision)
  });

  function stringList(value, field, moduleName) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
      throw new TypeError(`${moduleName}.${field} must be a string array`);
    }
    if (new Set(value).size !== value.length) {
      throw new TypeError(`${moduleName}.${field} contains duplicates`);
    }
    return Object.freeze([...value]);
  }

  function validateManifest(value) {
    if (!value || typeof value.name !== "string" || !value.name) {
      throw new TypeError("Browser module requires a name");
    }
    return Object.freeze({
      name: value.name,
      externals: stringList(value.externals || [], "externals", value.name),
      requires: stringList(value.requires || [], "requires", value.name),
      provides: stringList(value.provides || [], "provides", value.name),
      emits: stringList(value.emits || [], "emits", value.name),
      listens: stringList(value.listens || [], "listens", value.name)
    });
  }

  function dependencyCalls(manifest, actions) {
    return Object.freeze(Object.fromEntries(manifest.requires.map((name) => [name, (...args) => {
      const action = actions.get(name);
      if (!action) throw new Error(`${manifest.name} dependency is unavailable: ${name}`);
      return action(...args);
    }])));
  }

  function selectedExternals(manifest, externals) {
    return Object.freeze(Object.fromEntries(manifest.externals.map((name) => {
      if (!Object.prototype.hasOwnProperty.call(externals, name)) {
        throw new Error(`${manifest.name} external is unavailable: ${name}`);
      }
      return [name, externals[name]];
    })));
  }

  function validateImplementation(manifest, implementation) {
    if (!implementation || typeof implementation !== "object") {
      throw new TypeError(`${manifest.name} must return an implementation`);
    }
    const names = Object.keys(implementation).sort();
    const expected = [...manifest.provides].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new Error(`${manifest.name} implementation does not match declared provides`);
    }
    for (const name of names) {
      if (typeof implementation[name] !== "function") {
        throw new TypeError(`${manifest.name}.${name} must be a function`);
      }
    }
  }

  function listen(runtime, manifest, type, handler) {
    if (!manifest.listens.includes(type)) throw new Error(`${manifest.name} cannot listen for ${type}`);
    if (!EVENT_VALIDATORS[type]) throw new Error(`Unknown browser event: ${type}`);
    if (typeof handler !== "function") throw new TypeError(`${type} listener must be a function`);
    const handlers = runtime.listeners.get(type) || [];
    handlers.push(handler);
    runtime.listeners.set(type, handlers);
  }

  function emit(runtime, manifest, type, payload) {
    if (!manifest.emits.includes(type)) throw new Error(`${manifest.name} cannot emit ${type}`);
    const validator = EVENT_VALIDATORS[type];
    if (!validator?.(payload)) throw new TypeError(`Invalid ${type} event`);
    for (const handler of runtime.listeners.get(type) || []) handler(payload);
  }

  function install(runtime, browserModule) {
    const manifest = validateManifest(browserModule?.manifest);
    if (runtime.manifests.has(manifest.name)) throw new Error(`Duplicate browser module: ${manifest.name}`);
    for (const name of manifest.provides) {
      if (runtime.actions.has(name)) throw new Error(`Duplicate browser action: ${name}`);
    }
    const implementation = browserModule.create(Object.freeze({
      state: runtime.state,
      external: selectedExternals(manifest, runtime.externals),
      use: dependencyCalls(manifest, runtime.actions),
      emit: (type, payload) => emit(runtime, manifest, type, payload),
      listen: (type, handler) => listen(runtime, manifest, type, handler)
    }));
    validateImplementation(manifest, implementation);
    runtime.manifests.set(manifest.name, manifest);
    for (const [name, action] of Object.entries(implementation)) runtime.actions.set(name, action);
  }

  function validateDependencies(runtime) {
    for (const manifest of runtime.manifests.values()) {
      for (const name of manifest.requires) {
        if (!runtime.actions.has(name)) {
          throw new Error(`${manifest.name} dependency is unavailable: ${name}`);
        }
      }
    }
  }

  function finalizedRuntime(runtime) {
    return Object.freeze({
      state: runtime.state,
      call(name, ...args) {
        const action = runtime.actions.get(name);
        if (!action) throw new Error(`Unknown browser action: ${name}`);
        return action(...args);
      },
      facade(names) {
        return Object.freeze(Object.fromEntries(names.map((name) => {
          if (!runtime.actions.has(name)) throw new Error(`Unknown browser action: ${name}`);
          return [name, (...args) => runtime.actions.get(name)(...args)];
        })));
      },
      describe() {
        return [...runtime.manifests.values()].map((manifest) => ({ ...manifest }));
      }
    });
  }

  function createRuntime({ state, externals }) {
    if (!state || typeof state !== "object") throw new TypeError("Browser runtime requires state");
    if (!externals || typeof externals !== "object") throw new TypeError("Browser runtime requires externals");
    const runtime = {
      state, externals, actions: new Map(), manifests: new Map(), listeners: new Map()
    };
    return Object.freeze({
      install: (browserModule) => install(runtime, browserModule),
      finalize: () => {
        validateDependencies(runtime);
        return finalizedRuntime(runtime);
      }
    });
  }

  return Object.freeze({ EVENT_VALIDATORS, createRuntime, validateManifest });
});
