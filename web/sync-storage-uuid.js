(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughStorageUuid = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const MAX_TIMESTAMP_MS = (2 ** 48) - 1;
  const RANDOM_MAX = (1n << 74n) - 1n;
  const RAND_B_MASK = (1n << 62n) - 1n;
  const ENTROPY_ATTEMPTS = 16;

  class UUIDRangeError extends Error {
    constructor(message = "UUIDv7 generator state is outside the supported range.") {
      super(message);
      this.name = "UUIDRangeError";
    }
  }

  function uuidText(integer) {
    const hex = integer.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function fromParts(timestampMs, randomValue) {
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_TIMESTAMP_MS
      || typeof randomValue !== "bigint" || randomValue < 0n || randomValue > RANDOM_MAX) {
      throw new UUIDRangeError();
    }
    const randA = randomValue >> 62n;
    const randB = randomValue & RAND_B_MASK;
    return uuidText(
      (BigInt(timestampMs) << 80n) | (7n << 76n) | (randA << 64n) | (0b10n << 62n) | randB
    );
  }

  function parts(value) {
    if (typeof value !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new UUIDRangeError("Persisted UUIDv7 state is invalid.");
    }
    const integer = BigInt(`0x${value.replaceAll("-", "")}`);
    const timestampMs = Number(integer >> 80n);
    const randA = (integer >> 64n) & 0xFFFn;
    const randB = integer & RAND_B_MASK;
    return { integer, timestampMs, randomValue: (randA << 62n) | randB };
  }

  function latestPending(pendingIds) {
    const parsed = [];
    for (const identifier of pendingIds) {
      try {
        parsed.push(parts(identifier));
      } catch {
        // Historical UUIDv4 and opaque identifiers remain valid.
      }
    }
    return parsed.reduce(
      (latest, item) => latest == null || item.integer > latest.integer ? item : latest,
      null
    );
  }

  function sequential(previous, timestampMs, count) {
    if (!previous || timestampMs > previous.timestampMs) return null;
    const requested = BigInt(count);
    if (previous.randomValue > RANDOM_MAX - requested) {
      throw new UUIDRangeError("UUIDv7 random value has no headroom.");
    }
    return Array.from(
      { length: count },
      (_, index) => fromParts(previous.timestampMs, previous.randomValue + 1n + BigInt(index))
    );
  }

  function secureEntropy(bytes) {
    if (!globalThis.crypto?.getRandomValues) {
      throw new UUIDRangeError("Secure UUIDv7 entropy is unavailable.");
    }
    return globalThis.crypto.getRandomValues(bytes);
  }

  function randomBatch(timestampMs, count, entropy) {
    const maximumFirst = RANDOM_MAX - (BigInt(count) - 1n);
    const fillEntropy = entropy || secureEntropy;
    for (let attempt = 0; attempt < ENTROPY_ATTEMPTS; attempt += 1) {
      const bytes = new Uint8Array(10);
      const source = fillEntropy(bytes) ?? bytes;
      if (!(source instanceof Uint8Array) || source.length !== 10) {
        throw new UUIDRangeError("UUIDv7 entropy source returned invalid data.");
      }
      let randomValue = 0n;
      for (const byte of source) randomValue = (randomValue << 8n) | BigInt(byte);
      randomValue &= RANDOM_MAX;
      if (randomValue <= maximumFirst) {
        return Array.from({ length: count }, (_, index) => fromParts(timestampMs, randomValue + BigInt(index)));
      }
    }
    throw new UUIDRangeError("UUIDv7 entropy lacks reservation headroom.");
  }

  function reserve(timestampMs, count, stored, pendingIds = [], entropy = null) {
    if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0 || timestampMs > MAX_TIMESTAMP_MS
      || !Number.isSafeInteger(count) || count <= 0 || BigInt(count) > RANDOM_MAX + 1n) {
      throw new UUIDRangeError();
    }
    const storedParts = stored == null ? null : parts(stored);
    const pendingParts = latestPending(pendingIds || []);
    if (storedParts && pendingParts && pendingParts.integer > storedParts.integer) {
      throw new UUIDRangeError("Persisted UUIDv7 state predates a pending identifier.");
    }
    const previous = storedParts || pendingParts;
    return sequential(previous, timestampMs, count) || randomBatch(timestampMs, count, entropy);
  }

  return Object.freeze({
    MAX_TIMESTAMP_MS, RANDOM_MAX, UUIDRangeError,
    fromParts, parts, reserve
  });
});
