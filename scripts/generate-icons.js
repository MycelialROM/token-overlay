#!/usr/bin/env node
/**
 * Generates minimal placeholder icons in assets/ if they don't already exist.
 * Replace these with real icons for a polished release.
 *
 * PNG: 1×1 deep-blue pixel (valid, accepted by electron-builder)
 * ICO: minimal Windows ICO wrapper around the same pixel
 * ICNS: electron-builder will auto-convert from the PNG on macOS
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ── Minimal valid 16×16 PNG — dark teal (#0a7ea4) square ────────────────────
// Generated with: python3 -c "import zlib,struct,base64; ..."
// Pre-encoded to avoid runtime dependencies.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHklEQVQ4jWNgYGD4' +
  'z8BQDwABgQEAgQEA/////wAAAAAAAP//AwBQAAEAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/////AAAAAAAAAAAAAAAYrQAAAABJRU5ErkJggg==';

const PNG_BUF = Buffer.from(PNG_B64, 'base64');

// ── Minimal ICO (16×16) ──────────────────────────────────────────────────────
function makeTinyIco(pngBuf) {
  // ICO header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0,  0); // reserved
  header.writeUInt16LE(1,  2); // type: ICO
  header.writeUInt16LE(1,  4); // number of images

  // Directory entry
  const entry = Buffer.alloc(16);
  entry.writeUInt8(16,  0); // width  (0 = 256px, 16 = 16px)
  entry.writeUInt8(16,  1); // height
  entry.writeUInt8(0,   2); // color count
  entry.writeUInt8(0,   3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32,6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8);  // size of image data
  entry.writeUInt32LE(6 + 16,        12); // offset of image data (header + entry)

  return Buffer.concat([header, entry, pngBuf]);
}

const PNG_PATH  = path.join(ASSETS, 'icon.png');
const ICO_PATH  = path.join(ASSETS, 'icon.ico');
const ICNS_PATH = path.join(ASSETS, 'icon.icns');

if (!fs.existsSync(PNG_PATH)) {
  fs.writeFileSync(PNG_PATH, PNG_BUF);
  console.log('Generated placeholder icon.png');
}

if (!fs.existsSync(ICO_PATH)) {
  fs.writeFileSync(ICO_PATH, makeTinyIco(PNG_BUF));
  console.log('Generated placeholder icon.ico');
}

// electron-builder can auto-generate .icns from .png on macOS.
// For CI on non-macOS runners, we create a symlink or copy.
if (!fs.existsSync(ICNS_PATH)) {
  // On non-macOS we just copy the PNG as a placeholder;
  // electron-builder falls back to the png on linux/windows anyway.
  fs.copyFileSync(PNG_PATH, ICNS_PATH);
  console.log('Generated placeholder icon.icns (replace with real .icns for macOS)');
}

console.log('Icons ready in assets/');
