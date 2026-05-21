'use strict';

const { app, BrowserWindow, ipcMain, screen, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { load: loadConfig } = require('./lib/config');
const { open: openDb }     = require('./lib/db');
const { createServer }     = require('./lib/server');
const updater              = require('./lib/updater');

nativeTheme.themeSource = 'dark';
app.commandLine.appendSwitch('enable-transparent-visuals');

const WINDOW_W      = 340;
const WINDOW_H_FULL = 530;
const WINDOW_H_MINI = 72;
const USAGE_FILE    = path.join(os.homedir(), '.claude', 'token-usage.json');

let win        = null;
let db         = null;
let server     = null;
let dirWatcher = null;
let demoTimer  = null;
let config     = null;

// ─── DEMO MODE ────────────────────────────────────────────────────────────────
function startDemo() {
  if (fs.existsSync(USAGE_FILE)) return;

  const d = {
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    requests: 0, model: 'claude-sonnet-4-6', context_window: 200000,
    session_start: new Date().toISOString(), demo: true,
  };
  push('usage-update', d);

  demoTimer = setInterval(() => {
    if (!win || fs.existsSync(USAGE_FILE)) {
      clearInterval(demoTimer); demoTimer = null; return;
    }
    d.input_tokens          += Math.floor(Math.random() * 900 + 150);
    d.output_tokens         += Math.floor(Math.random() * 250 + 50);
    d.cache_read_tokens     += Math.floor(Math.random() * 4000 + 800);
    d.cache_creation_tokens += Math.floor(Math.random() * 120 + 10);
    d.requests              += 1;
    push('usage-update', { ...d });
  }, 2800);
}

// ─── LEGACY JSON FILE WATCHER ─────────────────────────────────────────────────
function watchLegacyFile() {
  const dir = path.join(os.homedir(), '.claude');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    dirWatcher = fs.watch(dir, (_, filename) => {
      if (filename === 'token-usage.json') readLegacyFile();
    });
  } catch (e) {
    console.warn('[watcher]', e.message);
  }
  readLegacyFile();
}

function readLegacyFile() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
    push('usage-update', { ...data, demo: false });
  } catch { setTimeout(readLegacyFile, 150); }
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────
function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: WINDOW_W, height: WINDOW_H_FULL,
    x: sw - WINDOW_W - 24, y: 24,
    transparent: true, backgroundColor: '#00000000',
    frame: false, alwaysOnTop: true,
    skipTaskbar: false, resizable: false,
    hasShadow: false, roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.once('did-finish-load', async () => {
    // Wait for sql.js WASM to finish loading before using the db
    try { await db.ready; } catch (e) {
      console.warn('[main] DB init failed:', e.message);
    }

    push('api-info', {
      tokenPrefix:   config.apiToken.slice(0, 8) + '…',
      configPath:    config.configPath,
      port:          config.port,
      usingFallback: db.usingFallback,
      version:       app.getVersion(),
    });

    try {
      const existing = db.getLatest();
      if (existing) push('usage-update', existing);
    } catch {}

    startDemo();
    watchLegacyFile();

    // Wire auto-updater after window is ready
    updater.setup(win);
  });

  win.on('closed', () => { win = null; cleanup(); });
}

function push(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('win-drag', (_, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

ipcMain.on('win-collapse', (_, collapsed) => {
  if (!win) return;
  win.setSize(WINDOW_W, collapsed ? WINDOW_H_MINI : WINDOW_H_FULL, true);
});

ipcMain.on('win-pin',   (_, pinned) => { win?.setAlwaysOnTop(pinned, 'screen-saver'); });
ipcMain.on('win-close', ()          => { win?.close(); });

ipcMain.handle('get-usage',    () => { try { return db.getLatest(); } catch { return null; } });
ipcMain.handle('get-sessions', () => { try { return db.allSessions?.() ?? []; } catch { return []; } });

ipcMain.on('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch {}
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanup() {
  if (demoTimer)  { clearInterval(demoTimer); demoTimer = null; }
  if (dirWatcher) { try { dirWatcher.close(); } catch {} dirWatcher = null; }
  if (server)     { server._limiter?.destroy(); server.close(); server = null; }
  if (db)         { db.close(); db = null; }
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  config = loadConfig();
  db     = openDb();

  server = createServer({
    port:      config.port,
    apiToken:  config.apiToken,
    rateLimit: config.rateLimit,
    db,
    onUpdate: (usage) => {
      if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
      push('usage-update', usage);
    },
    onReset: () => push('usage-reset'),
  });

  createWindow();
});

app.on('window-all-closed', () => { cleanup(); app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
