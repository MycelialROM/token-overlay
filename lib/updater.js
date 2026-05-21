'use strict';

/**
 * lib/updater.js — Auto-update via electron-updater + GitHub Releases.
 *
 * Checks for updates silently on startup. If a new version is downloaded,
 * sends 'update-downloaded' to the renderer so it can show a non-intrusive
 * notification. The update installs on next app quit.
 */

let autoUpdater;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // electron-updater missing in dev without full install — silently skip
}

function setup(win) {
  if (!autoUpdater) return;

  // Don't log to console in production
  autoUpdater.logger = null;
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', info => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-downloaded', {
        version:     info.version,
        releaseNotes: info.releaseNotes || null,
      });
    }
  });

  autoUpdater.on('error', () => {
    // Silent — update server might not be configured yet, or user is offline
  });

  // Delay first check so it doesn't compete with app startup
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 10_000);
}

module.exports = { setup };
