// Blocks repeated failed logins for one email + client address. In memory, so it resets on restart;
// a multi-instance deployment would need a shared store.

export function createLoginLimiter({ maxFailures, windowMs, now = () => Date.now() }) {
  const failures = new Map(); // key -> array of timestamps

  const recent = (key) => {
    const cutoff = now() - windowMs;
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length > 0) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };

  return {
    // Returns seconds until another attempt is allowed, or 0 when not blocked.
    retryAfterSeconds(key) {
      const kept = recent(key);
      if (kept.length < maxFailures) return 0;
      return Math.max(1, Math.ceil((kept[0] + windowMs - now()) / 1000));
    },
    recordFailure(key) {
      failures.set(key, [...recent(key), now()]);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
