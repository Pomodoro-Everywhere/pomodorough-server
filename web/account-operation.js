(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAccountOperation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const boundContexts = new WeakSet();
  function bind(identity, getDatabase, OwnershipError, captureIdentity) {
    const database = getDatabase();
    const assertConnection = () => {
      if (getDatabase() !== database) throw new OwnershipError();
    };
    const assertCurrent = () => { assertConnection(); identity.assertCurrent(); };
    const context = {
      get ownerId() { return identity.ownerId; },
      get localOwnerId() { return identity.localOwnerId; },
      get expectedUserId() { return identity.expectedUserId; },
      get currentUserId() { return identity.currentUserId; },
      assertCurrent,
      publishIdentity(publish) {
        assertCurrent();
        publish();
        assertConnection();
        const nextIdentity = captureIdentity();
        // A validated account handoff authorizes a new scope on this connection.
        // It cannot reactivate the old account's retry or transport callbacks.
        if (identity.ownerId && nextIdentity.ownerId !== identity.ownerId) {
          return bind(nextIdentity, getDatabase, OwnershipError, captureIdentity);
        }
        identity = nextIdentity;
        assertCurrent();
        return context;
      }
    };
    Object.defineProperty(context, "database", { value: database });
    boundContexts.add(context);
    return Object.freeze(context);
  }
  function requireBound(context) {
    if (!context || !boundContexts.has(context)) throw new TypeError("A bound account operation context is required.");
    context.assertCurrent();
    return context;
  }

  function isCurrent(context) {
    try { requireBound(context); return true; }
    catch (error) {
      if (error.name === "AccountOwnershipError") return false;
      throw error;
    }
  }

  return Object.freeze({ bind, requireBound, isCurrent });
});
