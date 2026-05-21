'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tok', {
  // ── Data listeners ─────────────────────────────────────────────────────────
  onUpdate:  (cb) => ipcRenderer.on('usage-update', (_, d) => cb(d)),
  onReset:   (cb) => ipcRenderer.on('usage-reset',  ()    => cb()),
  onApiInfo: (cb) => ipcRenderer.on('api-info',     (_, d) => cb(d)),

  // ── Queries ────────────────────────────────────────────────────────────────
  getUsage:    () => ipcRenderer.invoke('get-usage'),
  getSessions: () => ipcRenderer.invoke('get-sessions'),

  // ── Window control ─────────────────────────────────────────────────────────
  drag:     (delta) => ipcRenderer.send('win-drag',     delta),
  collapse: (v)     => ipcRenderer.send('win-collapse', v),
  pin:      (v)     => ipcRenderer.send('win-pin',      v),
  close:    ()      => ipcRenderer.send('win-close'),
});
