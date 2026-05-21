'use strict';

/**
 * lib/db.js — SQLite via sql.js (pure WASM, no native compilation).
 *
 * Works inside Electron's bundled Node 20 — no system Node required.
 * All queries use ? parameterization; zero string interpolation.
 * Database is saved to disk after every write.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const DB_PATH = path.join(os.homedir(), '.claude', 'token-overlay.db');

// ─── WASM path (dev vs packaged) ───────────────────────────────────────────────
function locateWasm(filename) {
  let base;
  try {
    const { app } = require('electron');
    base = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')
      : path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
  } catch {
    base = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
  }
  return path.join(base, filename);
}

// ─── SCHEMA ────────────────────────────────────────────────────────────────────
const SCHEMA = `
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
`;

// ─── JSON FALLBACK ─────────────────────────────────────────────────────────────
const JSON_PATH = path.join(os.homedir(), '.claude', 'token-usage.json');

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
    upsert(_sid, started, model, ctx, ev) {
      const prev = load() || {};
      const next = {
        session_id: _sid,
        session_start: new Date(started || Date.now()).toISOString(),
        model: model || prev.model,
        context_window: ctx || prev.context_window || 200000,
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
    replace(data) { const n = { ...data, demo: false }; save(n); return n; },
    reset()       { try { fs.unlinkSync(JSON_PATH); } catch {} },
    allSessions() { const d = load(); return d ? [d] : []; },
    close()       {},
  };
}

// ─── SQLITE via sql.js ─────────────────────────────────────────────────────────
function makeSqliteDb() {
  let _db  = null;   // sql.js Database instance
  let _ready = null; // Promise

  function save() {
    if (!_db) return;
    try {
      const data = _db.export();
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('[db] Save error:', e.message);
    }
  }

  // ── Helpers that run after _db is initialized ────────────────────────────
  function queryOne(sql, params) {
    const stmt = _db.prepare(sql);
    stmt.bind(params || []);
    const has = stmt.step();
    const row = has ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function queryAll(sql, params) {
    const stmt = _db.prepare(sql);
    stmt.bind(params || []);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function rowToUsage(row) {
    if (!row) return null;
    return {
      session_id:            row.id || row.session_id,
      session_start:         new Date(Number(row.started_at)).toISOString(),
      model:                 row.model   || null,
      context_window:        Number(row.context_window) || 200000,
      input_tokens:          Number(row.input_tokens)          || 0,
      output_tokens:         Number(row.output_tokens)         || 0,
      cache_read_tokens:     Number(row.cache_read_tokens)     || 0,
      cache_creation_tokens: Number(row.cache_creation_tokens) || 0,
      requests:              Number(row.requests)              || 0,
      demo:                  false,
    };
  }

  // ── Init (async — loads WASM then opens/creates DB) ──────────────────────
  _ready = (async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: locateWasm });

    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      _db = new SQL.Database(buf);
    } else {
      _db = new SQL.Database();
    }
    _db.run('PRAGMA foreign_keys = ON;');
    _db.run(SCHEMA);
    save(); // create file if new
  })();

  // ── Public interface (sync after ready) ──────────────────────────────────
  return {
    usingFallback: false,
    ready: _ready,

    getLatest() {
      return rowToUsage(queryOne(`
        SELECT s.id, s.started_at, s.model, s.context_window,
          COALESCE(SUM(e.input_tokens),          0) AS input_tokens,
          COALESCE(SUM(e.output_tokens),         0) AS output_tokens,
          COALESCE(SUM(e.cache_read_tokens),     0) AS cache_read_tokens,
          COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
          COUNT(e.id) AS requests
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.started_at DESC LIMIT 1
      `, []));
    },

    upsert(sessionId, started, model, ctx, ev) {
      _db.run(`
        INSERT INTO sessions(id, started_at, model, context_window) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          model          = COALESCE(excluded.model,          sessions.model),
          context_window = COALESCE(excluded.context_window, sessions.context_window)
      `, [sessionId, Number(started) || Date.now(), model || null, Number(ctx) || 200000]);

      _db.run(`
        INSERT INTO events(session_id, recorded_at, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens)
        VALUES(?,?,?,?,?,?)
      `, [
        sessionId, Date.now(),
        Number(ev.input_tokens)          || 0,
        Number(ev.output_tokens)         || 0,
        Number(ev.cache_read_tokens)     || 0,
        Number(ev.cache_creation_tokens) || 0,
      ]);

      save();

      return rowToUsage(queryOne(`
        SELECT s.id, s.started_at, s.model, s.context_window,
          COALESCE(SUM(e.input_tokens),          0) AS input_tokens,
          COALESCE(SUM(e.output_tokens),         0) AS output_tokens,
          COALESCE(SUM(e.cache_read_tokens),     0) AS cache_read_tokens,
          COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
          COUNT(e.id) AS requests
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        WHERE s.id = ? GROUP BY s.id
      `, [sessionId]));
    },

    replace(data) {
      const sid     = data.session_id || `manual-${Date.now()}`;
      const started = data.session_start ? new Date(data.session_start).getTime() : Date.now();

      _db.run(`DELETE FROM sessions WHERE id = ?`, [sid]);
      _db.run(`INSERT INTO sessions(id, started_at, model, context_window) VALUES(?,?,?,?)`,
        [sid, started, data.model || null, data.context_window || 200000]);
      _db.run(`INSERT INTO events(session_id, recorded_at, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens) VALUES(?,?,?,?,?,?)`,
        [sid, Date.now(),
          Number(data.input_tokens)          || 0,
          Number(data.output_tokens)         || 0,
          Number(data.cache_read_tokens)     || 0,
          Number(data.cache_creation_tokens) || 0]);

      save();

      return rowToUsage(queryOne(`
        SELECT s.id, s.started_at, s.model, s.context_window,
          COALESCE(SUM(e.input_tokens),          0) AS input_tokens,
          COALESCE(SUM(e.output_tokens),         0) AS output_tokens,
          COALESCE(SUM(e.cache_read_tokens),     0) AS cache_read_tokens,
          COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
          COUNT(e.id) AS requests
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        WHERE s.id = ? GROUP BY s.id
      `, [sid]));
    },

    reset() {
      _db.run(`DELETE FROM events`);
      _db.run(`DELETE FROM sessions`);
      save();
    },

    allSessions() {
      return queryAll(`
        SELECT s.id, s.started_at, s.model, s.context_window,
          COALESCE(SUM(e.input_tokens),  0) AS total_input,
          COALESCE(SUM(e.output_tokens), 0) AS total_output,
          COUNT(e.id) AS requests
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.started_at DESC LIMIT 50
      `, []);
    },

    close() {
      if (_db) { save(); _db.close(); _db = null; }
    },
  };
}

// ─── FACTORY ──────────────────────────────────────────────────────────────────
function open() {
  try {
    require.resolve('sql.js');
    return makeSqliteDb();
  } catch (e) {
    console.warn('[db] sql.js unavailable, using JSON fallback:', e.message);
    return makeJsonDb();
  }
}

module.exports = { open };
