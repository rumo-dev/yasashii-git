'use strict';
// UI検証用ブリッジ：Electron の代わりに、画面からの呼び出しを実際の git.js / gh.js につなぐ（本番では使わない）
const http = require('http');
const git = require('../src/git');
const gh = require('../src/gh');
const settings = { recent: [], showOriginal: true, theme: 'auto', lastRepo: process.env.YG_REPO || null };
const pickQueue = [];
let lastCode = null;
const app = {
  async pickFolder() { return pickQueue.shift() || null; },
  async getSettings() { return settings; },
  async setSettings(p) { Object.assign(settings, p); return settings; },
  async addRecent(d) { settings.recent = [d, ...settings.recent.filter((x) => x !== d)]; settings.lastRepo = d; return settings.recent; },
  async removeRecent(d) { settings.recent = settings.recent.filter((x) => x !== d); return settings.recent; },
  async openExternal() { return true }, async openFolder() { return true }, async openFile() { return true },
  async showInFolder() { return true }, async copyText() { return true }, async queuePick(d) { pickQueue.push(d); return true; }, async pollCode() { return lastCode; },
  async version() { return '0.1.0'; },
  async updateState() { return { status: 'disabled', mode: 'disabled', reason: 'テスト中', currentVersion: '0.1.0', version: '', notes: '', percent: 0, error: '' }; },
  async checkForUpdates() { return this.updateState(); }, async downloadUpdate() { return this.updateState(); }, async installUpdate() { return true; },
};
const NS = { git, gh, app };
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', async () => {
    const { ns, fn, args } = JSON.parse(b || '{}');
    let out;
    try { out = { ok: true, value: fn === 'loginWeb' ? await gh.loginWeb((c) => { lastCode = c; }) : await NS[ns][fn](...(args || [])) }; }
    catch (e) { out = { ok: false, error: { message: e.message, detail: e.detail || '', kind: e.kind || '' } }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
  });
}).listen(4599, '127.0.0.1', () => console.log('bridge ready'));
