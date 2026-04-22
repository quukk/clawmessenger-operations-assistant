"use strict";
/**
 * 环境模拟 (Polyfill)
 * 让融云 Web SDK (@rongcloud/imlib-next) 能在 Node.js 环境中运行
 */
require("fake-indexeddb/auto");

const { JSDOM } = require("jsdom");
const WebSocket = require("ws");
const { Blob, File } = require("node:buffer");
const crypto = require("crypto");

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  resources: 'usable',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
});

const window = dom.window;
const g = global;
const win = window;

function defineWinProp(key, value) {
  try {
    Object.defineProperty(win, key, {
      value: value,
      writable: true,
      configurable: true,
      enumerable: true
    });
  } catch {}
}

function defineGlobalProp(key, value) {
  try {
    Object.defineProperty(g, key, {
      value: value,
      writable: true,
      configurable: true,
      enumerable: true
    });
  } catch {}
}

if (g.indexedDB) {
  defineWinProp('indexedDB', g.indexedDB);
  defineWinProp('IDBKeyRange', g.IDBKeyRange);
  defineWinProp('IDBRequest', g.IDBRequest);
  defineWinProp('IDBDatabase', g.IDBDatabase);
  defineWinProp('IDBTransaction', g.IDBTransaction);
  defineWinProp('IDBCursor', g.IDBCursor);
  defineWinProp('IDBIndex', g.IDBIndex);
  defineWinProp('IDBFactory', g.IDBFactory);
}

const storageMock = {
  getItem: (k) => null,
  setItem: (k, v) => {},
  removeItem: (k) => {},
  clear: () => {},
  length: 0,
  key: (i) => null
};
defineWinProp('localStorage', storageMock);
defineWinProp('sessionStorage', storageMock);
defineGlobalProp('localStorage', storageMock);
defineGlobalProp('sessionStorage', storageMock);

if (!win.crypto) {
  defineWinProp('crypto', crypto.webcrypto);
}
if (!g.crypto) {
  defineGlobalProp('crypto', crypto.webcrypto);
}

defineWinProp('onLine', true);
defineWinProp('language', 'zh-CN');
defineGlobalProp('navigator', win.navigator);

defineGlobalProp('WebSocket', WebSocket);
defineGlobalProp('XMLHttpRequest', win.XMLHttpRequest);
defineGlobalProp('window', win);
defineGlobalProp('document', win.document);
defineGlobalProp('location', win.location);

if (!win.Blob) defineWinProp('Blob', Blob);
if (!win.File) defineWinProp('File', File);
if (!win.URL) defineWinProp('URL', { createObjectURL: () => '', revokeObjectURL: () => {} });

if (!win.requestAnimationFrame) defineWinProp('requestAnimationFrame', (cb) => setTimeout(cb, 16));
if (!win.cancelAnimationFrame) defineWinProp('cancelAnimationFrame', (id) => clearTimeout(id));
if (!win.performance) defineWinProp('performance', { now: () => Date.now() });

module.exports = { window };