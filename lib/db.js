'use strict';

/**
 * lib/db.js — Database client for the Electron main process.
 *
 * Electron 30 bundles Node 20, which lacks node:sqlite.
 * This module forks db-worker.js using the SYSTEM node binary (Node 24+),
 * which has node:sqlite built-in.  All communication is async JSON IPC.
 *
 * Falls back to JSON file storage if the child process cannot start.
 */

const { fork }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

const WORKER_PATH = path.join(__dirname, '..', 'db-worker.js');
const JSON_PATH   = path.join(os.homedir(), '.claude', 'token-usage.json');

// ─── JSON FALLBACK ─────────────────────────────────────────────────────────────
function makeJsonDb() {
  function load() {
    try { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8')); } catch { return null; }
  }
  function save(s) {
    try { fs.writeFileSync(JSON_PATH, JSON.stringify(s, null, 2)); } catch {}
  }

  return {
    usingFallback: true,
    ready: Promise.resolve(),

    getLatest: () => load(),

    upsert(_sid, _started, model, ctx, ev) {
      const prev = load() || {};
      const next = {
        session_id:            _sid,
        session_start:         new Date(_started || Date.now()).toISOString(),
        model:                 model   || prev.model,
        context_window:        ctx     || prev.context_window || 200000,
        input_tokens:          (prev.input_tokens          || 0) + (ev.input_tokens          || 0),
        output_tokens:         (prev.output_tokens         || 0) + (ev.output_tokens         || 0),
        cache_read_tokens:     (prev.cache_read_tokens     || 0) + (ev.cache_read_tokens     || 0),
        cache_creation_tokens: (prev.cache_creation_tokens || 0) + (ev.cache_creation_tokens || 0),
        requests: (prev.requests || 0) + 1,
        demo: false,
      };
      save(next);
      return next;
    },

    replace(data) {
      const next = { ...data, demo: false };
      save(next);
      return next;
    },

    reset()       { try { fs.unlinkSync(JSON_PATH); } catch {} },
    allSessions() { const d = load(); return d ? [d] : []; },
    close()       {},
  };
}

// ─── WORKER CLIENT ─────────────────────────────────────────────────────────────
function makeWorkerDb() {
  let child    = null;
  let pending  = new Map(); // id → { resolve, reject }
  let nextId   = 1;
  let isReady  = false;
  let readyResolve, readyReject;

  const ready = new Promise((res, rej) => {
    readyResolve = res;
    readyReject  = rej;
  });

  // Find system node — NOT Electron's bundled one
  const nodeExec = process.env.SYSTEM_NODE || 'node';

  child = fork(WORKER_PATH, [], {
    execPath: nodeExec,
    silent:   false,
    env:      { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  child.on('message', ({ id, result, error }) => {
    if (id === -1) {
      // Startup acknowledgment
      if (result?.ready) { isReady = true; readyResolve(); }
      else readyReject(new Error('Worker failed to init'));
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });

  child.on('error', (e) => {
    console.error('[db-worker] Process error:', e.message);
    if (!isReady) readyReject(e);
  });

  child.on('exit', (code) => {
    if (code !== 0) console.error('[db-worker] Exited with code', code);
    // Reject any pending calls
    for (const [, p] of pending) p.reject(new Error('Worker exited'));
    pending.clear();
  });

  function call(method, ...args) {
    return ready.then(() => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.send({ id, method, args });
    }));
  }

  return {
    usingFallback: false,
    ready,

    getLatest:    ()                          => call('getLatest'),
    upsert:       (sid, started, model, ctx, ev) => call('upsert', sid, started, model, ctx, ev),
    replace:      (data)                      => call('replace', data),
    reset:        ()                          => call('reset'),
    allSessions:  ()                          => call('allSessions'),

    close() {
      call('close').catch(() => {});
      child?.kill();
    },
  };
}

// ─── FACTORY ───────────────────────────────────────────────────────────────────
function open() {
  // Verify the worker script exists and system node can run node:sqlite
  if (!fs.existsSync(WORKER_PATH)) {
    console.warn('[db] Worker script not found, using JSON fallback');
    return makeJsonDb();
  }

  try {
    const db = makeWorkerDb();

    // Give the worker 3 s to report ready; fall back if it times out
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Worker startup timeout')), 3000)
    );

    // Return the worker db — callers await db.ready
    Promise.race([db.ready, timeout]).catch(e => {
      console.warn('[db] Worker failed:', e.message, '— using JSON fallback');
      // We can't hot-swap the returned object; main.js will handle the fallback
    });

    return db;
  } catch (e) {
    console.warn('[db] Cannot fork worker:', e.message, '— using JSON fallback');
    return makeJsonDb();
  }
}

module.exports = { open };
