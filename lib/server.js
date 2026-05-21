'use strict';

const http = require('http');
const { sanitizeUpdate, extractBearer, safeEqual } = require('./sanitize');
const { RateLimiter } = require('./rateLimit');

/**
 * Build and start the HTTP API server.
 *
 * @param {{ port, apiToken, rateLimit, db, onUpdate, onReset }} opts
 * @returns {http.Server}
 */
function createServer({ port, apiToken, rateLimit, db, onUpdate, onReset }) {
  const limiter = new RateLimiter(rateLimit.windowMs, rateLimit.maxRequests);

  // ── Middleware helpers ────────────────────────────────────────────────────

  function clientId(req) {
    // Hash of IP + User-Agent; never store raw values
    const ip = req.socket?.remoteAddress || '127.0.0.1';
    const ua = req.headers['user-agent'] || '';
    return `${ip}::${ua}`;
  }

  function checkAuth(req, res) {
    const token = extractBearer(req.headers['authorization']);
    if (!safeEqual(token, apiToken)) {
      send(res, 401, { error: 'Unauthorized' }, {
        'WWW-Authenticate': 'Bearer realm="token-overlay"',
      });
      return false;
    }
    return true;
  }

  function checkRate(req, res) {
    const result = limiter.check(clientId(req));
    const headers = {
      'X-RateLimit-Limit':     String(rateLimit.maxRequests),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset':     String(Math.ceil(result.resetAt / 1000)),
    };
    if (!result.allowed) {
      send(res, 429, { error: 'Too Many Requests', resetAt: result.resetAt }, headers);
      return false;
    }
    // Attach rate-limit headers to all OK responses
    req._rlHeaders = headers;
    return true;
  }

  function send(res, status, body, extra = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(json);
  }

  function collect(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) { reject(new Error('Payload too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  function parseJson(raw) {
    try { return JSON.parse(raw); }
    catch { throw new SyntaxError('Invalid JSON'); }
  }

  // ── Route handlers ────────────────────────────────────────────────────────

  async function handleStatus(req, res) {
    const usage = await db.getLatest().catch(() => null);
    const usingFallback = db.usingFallback ?? false;
    send(res, 200, { ok: true, usage, usingFallback }, req._rlHeaders);
  }

  async function handleUpdate(req, res) {
    let raw;
    try   { raw = parseJson(await collect(req)); }
    catch (e) { send(res, 400, { error: e.message }); return; }

    let clean;
    try   { clean = sanitizeUpdate(raw); }
    catch (e) { send(res, 422, { error: e.message }); return; }

    // Determine session identity
    const sessionId   = clean.session_id || `session-${new Date().toISOString().slice(0,10)}`;
    const sessionStart = clean.session_start
      ? new Date(clean.session_start).getTime()
      : Date.now();

    let usage;
    try {
      if (clean.add) {
        usage = await db.upsert(sessionId, sessionStart, clean.model, clean.context_window, clean);
      } else {
        usage = await db.replace({ ...clean, session_id: sessionId });
      }
    } catch (e) {
      console.error('[server] DB error:', e.message);
      send(res, 503, { error: 'Database temporarily unavailable' });
      return;
    }

    onUpdate(usage);
    send(res, 200, { ok: true }, req._rlHeaders);
  }

  async function handleReset(req, res) {
    await db.reset().catch(e => console.error('[server] Reset error:', e.message));
    onReset();
    send(res, 200, { ok: true }, req._rlHeaders);
  }

  // ── Request router ────────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    // CORS — localhost only
    res.setHeader('Access-Control-Allow-Origin',  'http://localhost');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Rate-limit every request (including GET /status)
    if (!checkRate(req, res)) return;

    // Public read-only endpoint
    if (req.method === 'GET' && req.url === '/status') {
      await handleStatus(req, res);
      return;
    }

    // All write endpoints require auth
    if (!checkAuth(req, res)) return;

    try {
      if (req.method === 'POST' && req.url === '/update') {
        await handleUpdate(req, res);
      } else if (req.method === 'POST' && req.url === '/reset') {
        handleReset(req, res);
      } else {
        send(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      console.error('[server] Unhandled error:', e);
      send(res, 500, { error: 'Internal server error' });
    }
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[server] Port ${port} already in use — is another instance running?`);
    } else {
      console.error('[server] Error:', e);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[token-overlay] API listening on http://127.0.0.1:${port}`);
  });

  server._limiter = limiter; // expose for cleanup
  return server;
}

module.exports = { createServer };
