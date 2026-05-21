'use strict';

const { timingSafeEqual } = require('crypto');

// Allowlist of known model prefixes
const MODEL_RE = /^claude-[a-z0-9][a-z0-9-]{0,60}$/;
// ISO 8601 date — loose check, new Date() validates further
const ISO_RE   = /^\d{4}-\d{2}-\d{2}T[\d:.Z+-]{5,}$/;
// Session IDs from Claude Code are UUIDs or short slugs
const SID_RE   = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate and sanitize the body of a POST /update request.
 * Returns a clean object. Throws on invalid input.
 */
function sanitizeUpdate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Body must be a JSON object');
  }

  const out = {};

  // ── integer token fields ─────────────────────────────────────────────────
  const INT_FIELDS = [
    'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_creation_tokens',
    'requests', 'context_window',
  ];
  for (const field of INT_FIELDS) {
    if (!(field in raw)) continue;
    const v = parseInt(raw[field], 10);
    if (!Number.isInteger(v) || v < 0 || v > 100_000_000) {
      throw new RangeError(`${field}: must be integer in [0, 100,000,000]`);
    }
    out[field] = v;
  }

  // ── float: total_cost_usd ────────────────────────────────────────────────
  if ('total_cost_usd' in raw) {
    const v = parseFloat(raw.total_cost_usd);
    if (!isFinite(v) || v < 0 || v > 1_000_000) {
      throw new RangeError('total_cost_usd: must be finite number in [0, 1,000,000]');
    }
    out.total_cost_usd = v;
  }

  // ── model ────────────────────────────────────────────────────────────────
  if ('model' in raw) {
    const v = String(raw.model).trim().toLowerCase();
    if (!MODEL_RE.test(v)) {
      throw new TypeError('model: invalid format (expected claude-*)');
    }
    out.model = v;
  }

  // ── session_id ───────────────────────────────────────────────────────────
  if ('session_id' in raw) {
    const v = String(raw.session_id).trim();
    if (!SID_RE.test(v)) {
      throw new TypeError('session_id: invalid characters or length');
    }
    out.session_id = v;
  }

  // ── session_start ────────────────────────────────────────────────────────
  if ('session_start' in raw) {
    const s = String(raw.session_start).trim();
    if (!ISO_RE.test(s)) throw new TypeError('session_start: must be ISO 8601');
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new TypeError('session_start: not a valid date');
    out.session_start = d.toISOString();
  }

  // ── boolean flags ─────────────────────────────────────────────────────────
  if ('add' in raw) out.add = raw.add === true || raw.add === 'true';

  return out;
}

/**
 * Validate a bearer token string from the Authorization header.
 * Returns the raw token or null.
 */
function extractBearer(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+([A-Za-z0-9+/=._~-]+)$/i);
  return m ? m[1] : null;
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Pad shorter string to prevent early exit on length mismatch (timing leak)
  const aBuf = Buffer.from(a.padEnd(64, '\0'));
  const bBuf = Buffer.from(b.padEnd(64, '\0'));
  const lengthsMatch = a.length === b.length;
  // Always run timingSafeEqual regardless of length match
  return timingSafeEqual(aBuf, bBuf) && lengthsMatch;
}

module.exports = { sanitizeUpdate, extractBearer, safeEqual };
