#!/usr/bin/env node
/**
 * claude-hook.js  —  Claude Code Stop hook for token-overlay.
 *
 * Claude Code pipes a JSON payload to stdin on every Stop event.
 * This script reads it, validates the fields, and POSTs to the overlay
 * using the bearer token from ~/.claude/token-overlay-config.json.
 *
 * ── INSTALL ───────────────────────────────────────────────────────────────────
 *
 * Add to ~/.claude/settings.json  (global)  OR  .claude/settings.json  (project):
 *
 *   {
 *     "hooks": {
 *       "Stop": [
 *         {
 *           "matcher": "",
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "node C:/Users/steve-laptop/token-overlay/claude-hook.js"
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── PAYLOAD SHAPE (Claude Code Stop) ─────────────────────────────────────────
 *
 *   {
 *     "session_id": "uuid",
 *     "usage": {
 *       "input_tokens": 12345,
 *       "output_tokens": 678,
 *       "cache_creation_input_tokens": 0,
 *       "cache_read_input_tokens": 90123
 *     },
 *     "model": "claude-sonnet-4-6"
 *   }
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'token-overlay-config.json');
const MAX_STDIN   = 64 * 1024; // 64 KB — reject oversized payloads

// ── Validation (mirrors server-side sanitize) ─────────────────────────────────
const MODEL_RE = /^claude-[a-z0-9][a-z0-9-]{0,60}$/;
const SID_RE   = /^[a-zA-Z0-9_-]{1,128}$/;

function clamp(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function sanitize(event) {
  if (!event || typeof event !== 'object') return null;

  const usage = event.usage || event;
  if (typeof usage !== 'object') return null;

  const MAX_T = 100_000_000;

  const out = {
    add: true, // always accumulate from hooks
    input_tokens:          clamp(usage.input_tokens,                    0, MAX_T),
    output_tokens:         clamp(usage.output_tokens,                   0, MAX_T),
    cache_read_tokens:     clamp(usage.cache_read_input_tokens     ?? usage.cache_read_tokens,     0, MAX_T),
    cache_creation_tokens: clamp(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens, 0, MAX_T),
    requests: 1,
  };

  const model = (event.model || usage.model || '').trim().toLowerCase();
  if (MODEL_RE.test(model)) out.model = model;

  const sid = (event.session_id || '').trim();
  if (SID_RE.test(sid)) out.session_id = sid;

  // Only set session_start once per unique session_id
  if (out.session_id) out.session_start = new Date().toISOString();

  return out;
}

// ── Config ────────────────────────────────────────────────────────────────────
function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { return null; }
}

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path:   '/update',
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization':  `Bearer ${token}`,
          'User-Agent':     'token-overlay-hook/1.0',
        },
      },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = readConfig();
  if (!cfg?.apiToken) return; // overlay not set up — exit silently

  // Read stdin with size limit
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN) return; // oversized — drop silently
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return; // empty stdin — test invocation

  let event;
  try { event = JSON.parse(raw); }
  catch { return; } // malformed JSON — exit silently, don't break Claude Code

  const body = sanitize(event);
  if (!body) return;

  // Post; failures are silent so the hook never blocks Claude Code
  await post(cfg.port || 51234, cfg.apiToken, body).catch(() => {});
}

main().catch(() => {});
