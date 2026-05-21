'use strict';

const { createHash } = require('crypto');

/**
 * Hash-based sliding-window rate limiter.
 *
 * Identifiers are SHA-256 hashed before storage so the internal map never
 * contains raw IP addresses or user-agent strings.
 */
class RateLimiter {
  /**
   * @param {number} windowMs   - Sliding window duration in milliseconds
   * @param {number} maxReqs    - Max allowed requests per window
   */
  constructor(windowMs, maxReqs) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be positive integer');
    if (!Number.isInteger(maxReqs)  || maxReqs  <= 0) throw new RangeError('maxReqs must be positive integer');

    this.windowMs  = windowMs;
    this.maxReqs   = maxReqs;
    /** @type {Map<string, number[]>} hash → sorted timestamp list */
    this._store    = new Map();
    this._cleanupTimer = setInterval(() => this._cleanup(), Math.max(windowMs, 30_000));
    this._cleanupTimer.unref?.(); // don't keep process alive
  }

  /**
   * Check whether the given identifier should be allowed.
   *
   * @param {string} identifier - Raw identifier (IP, user-agent, etc.)
   * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
   */
  check(identifier) {
    const hash  = this._hash(identifier);
    const now   = Date.now();
    const cutoff = now - this.windowMs;

    const timestamps = (this._store.get(hash) || []).filter(t => t > cutoff);

    if (timestamps.length >= this.maxReqs) {
      this._store.set(hash, timestamps);
      return {
        allowed:   false,
        remaining: 0,
        resetAt:   timestamps[0] + this.windowMs,
      };
    }

    timestamps.push(now);
    this._store.set(hash, timestamps);

    return {
      allowed:   true,
      remaining: this.maxReqs - timestamps.length,
      resetAt:   timestamps[0] + this.windowMs,
    };
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this._store.clear();
  }

  _hash(raw) {
    return createHash('sha256').update(String(raw)).digest('hex');
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [hash, ts] of this._store) {
      const fresh = ts.filter(t => t > cutoff);
      if (fresh.length === 0) this._store.delete(hash);
      else this._store.set(hash, fresh);
    }
  }
}

module.exports = { RateLimiter };
