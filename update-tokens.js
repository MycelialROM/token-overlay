#!/usr/bin/env node
/**
 * update-tokens  —  CLI client for the token-overlay HTTP API.
 *
 * Reads the bearer token and port from ~/.claude/token-overlay-config.json
 * automatically. The full token is never shown in output.
 *
 * Usage:
 *   node update-tokens.js --input 5000 --output 1200 --model claude-sonnet-4-6
 *   node update-tokens.js --add --input 800 --output 200   # accumulate
 *   node update-tokens.js --session-id abc123 --add --input 500
 *   node update-tokens.js --reset
 *   node update-tokens.js --status
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.claude', 'token-overlay-config.json');

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.error(`Config not found: ${CONFIG_PATH}`);
      console.error('Is the overlay running? Start it with: npm start');
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error('Cannot read config:', e.message);
    process.exit(1);
  }
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
function request(port, apiToken, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'User-Agent': 'token-overlay-cli/1.0',
    };
    if (data) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
          catch { resolve({ status: res.statusCode, body: out }); }
        });
      }
    );

    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Argument parsing ─────────────────────────────────────────────────────────
function arg(argv, name) {
  const i = argv.indexOf('--' + name);
  return i !== -1 ? argv[i + 1] : null;
}
function flag(argv, name) { return argv.includes('--' + name); }

// ── Input validation (mirrors server-side sanitize) ─────────────────────────
function validateInt(name, value) {
  const v = parseInt(value, 10);
  if (!Number.isInteger(v) || v < 0 || v > 100_000_000) {
    console.error(`${name}: must be integer in [0, 100,000,000]`);
    process.exit(1);
  }
  return v;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv   = process.argv.slice(2);
  const cfg    = readConfig();
  const port   = cfg.port || 51234;
  const token  = cfg.apiToken;

  if (!token) {
    console.error('No API token in config. Run the overlay first to generate one.');
    process.exit(1);
  }

  if (flag(argv, 'status')) {
    const r = await request(port, token, 'GET', '/status', null).catch(connectErr);
    if (r.status === 200) {
      console.log(JSON.stringify(r.body.usage, null, 2));
    } else {
      console.error('Error:', r.status, JSON.stringify(r.body));
    }
    return;
  }

  if (flag(argv, 'reset')) {
    const r = await request(port, token, 'POST', '/reset', {}).catch(connectErr);
    console.log(r.status === 200 ? '✓ Session reset' : '✗ ' + JSON.stringify(r.body));
    return;
  }

  // Build payload — client-side validation mirrors server sanitize
  const body = { add: flag(argv, 'add') };

  const rawInput = arg(argv, 'input') ?? arg(argv, 'input-tokens');
  const rawOutput = arg(argv, 'output') ?? arg(argv, 'output-tokens');
  const rawCr    = arg(argv, 'cache-read') ?? arg(argv, 'cache-read-tokens');
  const rawCw    = arg(argv, 'cache-write') ?? arg(argv, 'cache-write-tokens');

  if (rawInput  != null) body.input_tokens          = validateInt('--input',       rawInput);
  if (rawOutput != null) body.output_tokens         = validateInt('--output',      rawOutput);
  if (rawCr     != null) body.cache_read_tokens     = validateInt('--cache-read',  rawCr);
  if (rawCw     != null) body.cache_creation_tokens = validateInt('--cache-write', rawCw);

  const model = arg(argv, 'model');
  if (model != null) {
    if (!/^claude-[a-z0-9-]{1,60}$/.test(model)) {
      console.error('--model: invalid format'); process.exit(1);
    }
    body.model = model;
  }

  const sessionId = arg(argv, 'session-id');
  if (sessionId != null) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      console.error('--session-id: invalid characters'); process.exit(1);
    }
    body.session_id = sessionId;
  }

  const rawRequests = arg(argv, 'requests');
  if (rawRequests != null) body.requests = validateInt('--requests', rawRequests);
  else if (body.add) body.requests = 1;

  if (Object.keys(body).filter(k => k !== 'add').length === 0) {
    console.error('No token counts provided. Use --input, --output, --cache-read, --cache-write');
    console.error('Run with --status to see current usage, --reset to clear.');
    process.exit(1);
  }

  const r = await request(port, token, 'POST', '/update', body).catch(connectErr);

  if (r.status === 401) {
    console.error('Authentication failed. Check that the config file matches the running overlay.');
  } else if (r.status === 429) {
    console.error('Rate limited. Slow down requests or increase rateLimit.maxRequests in config.');
  } else if (r.status === 422) {
    console.error('Validation error:', r.body?.error);
  } else if (r.status === 200) {
    console.log('✓ Updated');
  } else {
    console.error('Unexpected response:', r.status, r.body);
  }
}

function connectErr(e) {
  console.error('Cannot reach overlay on port', process.env.PORT || 51234);
  console.error('Is the overlay running?  →  cd token-overlay && npm start');
  console.error(e.message);
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
