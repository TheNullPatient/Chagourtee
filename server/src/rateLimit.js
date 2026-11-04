'use strict';

/**
 * Small in-memory fixed-window rate limiter.
 *
 * It is intentionally dependency-free: the server has no shared state and one
 * process owns the SQLite database, so a process-local counter is enough to
 * slow down credential stuffing and abusive registration attempts. Counters
 * reset automatically, and the periodic sweep keeps the map from growing
 * without bound when many IPs or logins are tried.
 */
function createRateLimiter({ windowMs, max, cleanupIntervalMs = 60 * 1000 }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('max must be a positive number');
  }

  const buckets = new Map();

  function keyOf(key) {
    return String(key);
  }

  function getBucket(key) {
    const normalized = keyOf(key);
    const now = Date.now();
    let bucket = buckets.get(normalized);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(normalized, bucket);
    }

    return bucket;
  }

  /**
   * Returns whether the next attempt is allowed. It does not increment the
   * counter, so failed attempts must be recorded with hit().
   */
  function check(key) {
    const bucket = getBucket(key);
    if (bucket.count >= max) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, bucket.resetAt - Date.now()),
      };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  function hit(key) {
    const bucket = getBucket(key);
    bucket.count += 1;
  }

  function reset(key) {
    buckets.delete(keyOf(key));
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, cleanupIntervalMs);
  if (typeof cleanup.unref === 'function') cleanup.unref();

  return { check, hit, reset };
}

module.exports = { createRateLimiter };
