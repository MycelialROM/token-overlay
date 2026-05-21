'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'token-overlay-config.json');

const DEFAULTS = {
  port: 51234,
  rateLimit: { windowMs: 60_000, maxRequests: 120 },
};

let _cached = null;

function load() {
  if (_cached) return _cached;

  let raw = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.warn('[config] Read error, using defaults:', e.message);
  }

  // Auto-generate bearer token on first run — never hardcoded
  if (typeof raw.apiToken !== 'string' || raw.apiToken.length < 32) {
    raw.apiToken = crypto.randomBytes(32).toString('hex');
    _save(raw);
  }

  const port = Number.isInteger(raw.port) && raw.port > 1024 && raw.port < 65536
    ? raw.port
    : DEFAULTS.port;

  const windowMs = Number.isInteger(raw.rateLimit?.windowMs) && raw.rateLimit.windowMs > 0
    ? raw.rateLimit.windowMs
    : DEFAULTS.rateLimit.windowMs;

  const maxRequests = Number.isInteger(raw.rateLimit?.maxRequests) && raw.rateLimit.maxRequests > 0
    ? raw.rateLimit.maxRequests
    : DEFAULTS.rateLimit.maxRequests;

  _cached = Object.freeze({
    port,
    apiToken: raw.apiToken,
    configPath: CONFIG_PATH,
    rateLimit: Object.freeze({ windowMs, maxRequests }),
  });

  return _cached;
}

function _save(data) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[config] Write error:', e.message);
  }
}

// Invalidate cache so tests can reload
function _reset() { _cached = null; }

module.exports = { load, _reset, CONFIG_PATH };
