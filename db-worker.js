/**
 * db-worker.js — SQLite database worker.
 *
 * Runs under SYSTEM Node (24+) which ships node:sqlite as a built-in.
 * Spawned by main.js via child_process.fork() with execPath set to the
 * system 'node' binary, bypassing Electron's bundled Node 20.
 *
 * Protocol: JSON messages over process.send/process.on('message').
 *   Incoming:  { id: number, method: string, args: any[] }
 *   Outgoing:  { id: number, result: any }  |  { id: number, error: string }
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// ─── Schema ────────────────────────────────────────────────────────────────────
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT    PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  model          TEXT,
  context_window INTEGER NOT NULL DEFAULT 200000
);

CREATE TABLE IF NOT EXISTS events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recorded_at           INTEGER NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_time    ON events(recorded_at);
`;

const DB_PATH = path.join(os.homedir(), '.claude', 'token-overlay.db');

let db = null;

// ─── Prepared statement cache ──────────────────────────────────────────────────
let stmts = null;

function initStatements() {
  // ALL queries are prepared statements — zero string interpolation
  stmts = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, started_at, model, context_window)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model          = COALESCE(excluded.model,          sessions.model),
        context_window = COALESCE(excluded.context_window, sessions.context_window)
    `),

    insertEvent: db.prepare(`
      INSERT INTO events
        (session_id, recorded_at, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    sessionTotals: db.prepare(`
      SELECT
        s.id            AS session_id,
        s.started_at,
        s.model,
        s.context_window,
        COALESCE(SUM(e.input_tokens),          0) AS input_tokens,
        COALESCE(SUM(e.output_tokens),         0) AS output_tokens,
        COALESCE(SUM(e.cache_read_tokens),     0) AS cache_read_tokens,
        COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
        COUNT(e.id) AS requests
      FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `),

    latestSession: db.prepare(`
      SELECT
        s.id            AS session_id,
        s.started_at,
        s.model,
        s.context_window,
        COALESCE(SUM(e.input_tokens),          0) AS input_tokens,
        COALESCE(SUM(e.output_tokens),         0) AS output_tokens,
        COALESCE(SUM(e.cache_read_tokens),     0) AS cache_read_tokens,
        COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
        COUNT(e.id) AS requests
      FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 1
    `),

    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),

    deleteAllEvents:   db.prepare(`DELETE FROM events`),
    deleteAllSessions: db.prepare(`DELETE FROM sessions`),

    allSessions: db.prepare(`
      SELECT
        s.id, s.started_at, s.model, s.context_window,
        COALESCE(SUM(e.input_tokens),  0) AS total_input,
        COALESCE(SUM(e.output_tokens), 0) AS total_output,
        COUNT(e.id) AS requests
      FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 50
    `),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function rowToUsage(row) {
  if (!row) return null;
  return {
    session_id:            row.session_id,
    session_start:         new Date(Number(row.started_at)).toISOString(),
    model:                 row.model   || null,
    context_window:        Number(row.context_window) || 200000,
    input_tokens:          Number(row.input_tokens),
    output_tokens:         Number(row.output_tokens),
    cache_read_tokens:     Number(row.cache_read_tokens),
    cache_creation_tokens: Number(row.cache_creation_tokens),
    requests:              Number(row.requests),
    demo:                  false,
  };
}

// ─── Method handlers ───────────────────────────────────────────────────────────
const handlers = {
  open() {
    if (db) return { ok: true };
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(SCHEMA);
    initStatements();
    return { ok: true, path: DB_PATH };
  },

  getLatest() {
    const row = stmts.latestSession.get();
    return rowToUsage(row);
  },

  upsert([sessionId, started, model, ctx, ev]) {
    // Single atomic transaction: upsert session + insert event
    db.exec('BEGIN');
    try {
      stmts.upsertSession.run(
        sessionId,
        Number(started) || Date.now(),
        model || null,
        Number(ctx) || 200000,
      );
      stmts.insertEvent.run(
        sessionId,
        Date.now(),
        Number(ev.input_tokens)          || 0,
        Number(ev.output_tokens)         || 0,
        Number(ev.cache_read_tokens)     || 0,
        Number(ev.cache_creation_tokens) || 0,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const row = stmts.sessionTotals.get(sessionId);
    return rowToUsage(row);
  },

  replace([data]) {
    const sid     = data.session_id || `manual-${Date.now()}`;
    const started = data.session_start
      ? new Date(data.session_start).getTime()
      : Date.now();

    db.exec('BEGIN');
    try {
      stmts.deleteSession.run(sid);
      stmts.upsertSession.run(sid, started, data.model || null, data.context_window || 200000);
      stmts.insertEvent.run(
        sid, Date.now(),
        Number(data.input_tokens)          || 0,
        Number(data.output_tokens)         || 0,
        Number(data.cache_read_tokens)     || 0,
        Number(data.cache_creation_tokens) || 0,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const row = stmts.sessionTotals.get(sid);
    return rowToUsage(row);
  },

  reset() {
    db.exec('BEGIN');
    stmts.deleteAllEvents.run();
    stmts.deleteAllSessions.run();
    db.exec('COMMIT');
    return { ok: true };
  },

  allSessions() {
    return stmts.allSessions.all();
  },

  close() {
    if (db) { db.close(); db = null; stmts = null; }
    return { ok: true };
  },
};

// ─── Message loop ──────────────────────────────────────────────────────────────
process.on('message', ({ id, method, args }) => {
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    const result = handler(args || []);
    process.send({ id, result });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});

// Auto-open on start
handlers.open();

if (typeof process.send === 'function') {
  process.send({ id: -1, result: { ready: true } });
} else {
  // Running standalone (e.g. direct node invocation for testing)
  console.log('[db-worker] Ready (standalone mode). DB path:', DB_PATH);
}
