'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 操作を呼び出す。失敗時は message / detail を持つ Error を投げる */
  async call(ns, fn, ...args) {
    const r = await ipcRenderer.invoke('call', ns, fn, args);
    if (r.ok) return r.value;
    const err = new Error(r.error.message);
    err.detail = r.error.detail;
    err.kind = r.error.kind || ''; // 'auth'（ログイン切れ）/ 'ssh'（SSH鍵）/ ''
    throw err;
  },
  async ghLoginWeb() {
    const r = await ipcRenderer.invoke('gh-login-web');
    if (r.ok) return r.value;
    const err = new Error(r.error.message); err.detail = r.error.detail; err.kind = r.error.kind || ''; throw err;
  },
  onGhLoginCode(cb) { ipcRenderer.on('gh-login-code', (_e, code) => cb(code)); },
  onProgress(cb) { ipcRenderer.on('progress', (_e, p) => cb(p)); },
  onMenu(cb) { ipcRenderer.on('menu', (_e, name) => cb(name)); },
  onUpdateState(cb) { ipcRenderer.on('update-state', (_e, st) => cb(st)); },
});
