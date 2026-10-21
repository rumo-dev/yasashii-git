'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const git = require('./src/git');
const gh = require('./src/gh');
const updaterLib = require('./src/updater');

let win = null;

// Finder / スタートメニューから起動すると PATH が狭く、gh や Homebrew の git が見つからないことがあるため補う
(function extendPath() {
  const sep = path.delimiter;
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
    : process.platform === 'win32' ? ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\GitHub CLI', 'C:\\Program Files (x86)\\Git\\cmd']
    : ['/usr/local/bin', '/snap/bin'];
  const cur = (process.env.PATH || '').split(sep);
  process.env.PATH = [...cur, ...extra.filter((d) => !cur.includes(d))].join(sep);
})();

/* ----------------------------- 保存データ ----------------------------- */
const storePath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { recent: [], showOriginal: true, theme: 'auto', lastRepo: null, safetyCheck: true, autoUpdateCheck: true };
function readStore() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}
function writeStore(s) {
  try { fs.mkdirSync(path.dirname(storePath()), { recursive: true }); fs.writeFileSync(storePath(), JSON.stringify(s, null, 2)); }
  catch (_) { /* 無視 */ }
}

/* ------------------------------ アプリ機能 ------------------------------ */
const appApi = {
  async pickFolder(title, defaultPath) {
    const opts = { title: title || 'フォルダを選んでください', properties: ['openDirectory', 'createDirectory'] };
    if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
    const r = await dialog.showOpenDialog(win, opts);
    return r.canceled ? null : r.filePaths[0];
  },
  async getSettings() { return readStore(); },
  async setSettings(patch) { const s = { ...readStore(), ...patch }; writeStore(s); return s; },
  async addRecent(dir) {
    const s = readStore();
    s.recent = [dir, ...s.recent.filter((d) => d !== dir)].slice(0, 12);
    s.lastRepo = dir; writeStore(s); return s.recent;
  },
  async removeRecent(dir) {
    const s = readStore(); s.recent = s.recent.filter((d) => d !== dir);
    if (s.lastRepo === dir) s.lastRepo = null;
    writeStore(s); return s.recent;
  },
  async openExternal(url) {
    if (!/^https:\/\//i.test(url)) throw new Error('https のURLだけ開けます。');
    await shell.openExternal(url); return true;
  },
  async openFolder(dir) { await shell.openPath(dir); return true; },
  async openFile(repo, rel) {
    const abs = path.resolve(repo, rel);
    if (path.relative(repo, abs).startsWith('..')) throw new Error('リポジトリの外のファイルは開けません。');
    const err = await shell.openPath(abs);
    if (err) throw new Error('ファイルを開けませんでした：' + err);
    return true;
  },
  async showInFolder(repo, rel) { shell.showItemInFolder(path.resolve(repo, rel)); return true; },
  async copyText(text) { clipboard.writeText(String(text)); return true; },
  async version() { return app.getVersion(); },
  /* 自動更新（src/updater.js）。状態の変化は 'update-state' で画面へ届く */
  async updateState() { return updater.getState(); },
  async checkForUpdates() { return updater.check({ manual: true }); },
  async downloadUpdate() { return updater.download(); },
  async installUpdate() {
    if (!updater.install()) throw new Error('まだ更新の準備ができていません。');
    return true;
  },
};

/* ------------------------------ 自動更新 ------------------------------ */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 起動中は6時間ごとに確認
const UPDATE_FIRST_CHECK_MS = 15 * 1000;             // 起動して15秒後に最初の確認（起動をじゃましない）
let updater = null;

function setupUpdater() {
  // 配布先の設定（インストーラーを作るとき electron-builder が app-update.yml に書き込む。開発中などは無い）
  let feedText = '';
  try { feedText = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'); } catch (_) { /* 無い */ }
  const feed = updaterLib.parseAppUpdateYml(feedText); // GitHub の owner/repo（ダウンロードページのリンク用）
  // macSigned: コード署名した Mac 版を配るようになったら true にする（署名がないと Mac は自動で入れ替えられない）
  let { mode, reason } = updaterLib.detectMode({ platform: process.platform, isPackaged: app.isPackaged, env: process.env, hasFeed: !!feedText.trim(), macSigned: false });
  let autoUpdater = null;
  if (mode !== 'disabled') {
    try { autoUpdater = require('electron-updater').autoUpdater; }
    catch (_) { mode = 'disabled'; reason = '更新の部品を読み込めませんでした。'; }
  }
  const repo = feed || updaterLib.parseRepository(require('./package.json').repository);
  updater = updaterLib.createUpdater({
    autoUpdater, mode, reason,
    currentVersion: app.getVersion(),
    releasePageUrl: repo ? `https://github.com/${repo.owner}/${repo.repo}/releases/latest` : '',
    openExternal: (url) => shell.openExternal(url),
  });
  updater.onState((st) => { if (win && !win.isDestroyed()) win.webContents.send('update-state', st); });
  const tick = () => { if (readStore().autoUpdateCheck !== false) updater.check({ manual: false }).catch(() => {}); };
  setTimeout(tick, UPDATE_FIRST_CHECK_MS);
  setInterval(tick, UPDATE_CHECK_INTERVAL_MS);
}

/* ------------------------------ IPC ------------------------------ */
const NAMESPACES = { git, gh, app: appApi };
const BLOCKED = new Set(['run', 'GitError', 'GhError', 'friendly', 'loginWeb']);

ipcMain.handle('call', async (_e, ns, fn, args) => {
  try {
    const mod = NAMESPACES[ns];
    if (!mod || BLOCKED.has(fn) || typeof mod[fn] !== 'function') throw new Error(`未対応の操作です: ${ns}.${fn}`);
    let a = args || [];
    // アップロードの進み具合を画面へ知らせる
    if (ns === 'git' && fn === 'push') a = [a[0], a[1] || {}, (p) => { try { _e.sender.send('progress', { op: 'push', ...p }); } catch (_) { /* 無視 */ } }];
    const value = await mod[fn](...a);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: { message: e.message || String(e), detail: e.detail || '', kind: e.kind || '' } };
  }
});

ipcMain.handle('gh-login-web', async (e) => {
  try {
    const value = await gh.loginWeb((code) => {
      e.sender.send('gh-login-code', code);
      shell.openExternal('https://github.com/login/device').catch(() => {});
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: { message: err.message, detail: err.detail || '', kind: err.kind || '' } };
  }
});

/* ------------------------------ ウィンドウ ------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600,
    title: 'やさしいGit',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('file://')) ev.preventDefault(); });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send('menu', ch);
  const template = [
    {
      label: 'ファイル',
      submenu: [
        { label: 'フォルダを開く…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: '新しいプロジェクトを作る…', accelerator: 'CmdOrCtrl+N', click: send('init') },
        { label: 'ダウンロードして始める…', accelerator: 'CmdOrCtrl+Shift+O', click: send('clone') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit', label: process.platform === 'darwin' ? '閉じる' : '終了' },
      ],
    },
    {
      label: '操作',
      submenu: [
        { label: 'まとめて更新', accelerator: 'CmdOrCtrl+Shift+R', click: send('sync') },
        { label: '更新を確認', accelerator: 'CmdOrCtrl+Shift+F', click: send('fetch') },
        { label: '最新を取り込む', accelerator: 'CmdOrCtrl+Shift+L', click: send('pull') },
        { label: 'アップロード', accelerator: 'CmdOrCtrl+Shift+U', click: send('push') },
        { type: 'separator' },
        { label: '画面を更新', accelerator: 'F5', click: send('refresh') },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' }, { role: 'redo', label: 'やり直し' }, { type: 'separator' },
        { role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: '貼り付け' }, { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'resetZoom', label: '文字の大きさを標準に' }, { role: 'zoomIn', label: '文字を大きく' }, { role: 'zoomOut', label: '文字を小さく' },
        { type: 'separator' }, { role: 'togglefullscreen', label: '全画面表示' },
        { role: 'toggleDevTools', label: '開発者ツール' },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: '用語の対応表（やさしい言い方 ⇔ Git用語）', click: send('glossary') },
        { label: 'Git の公式ドキュメント（日本語）', click: () => shell.openExternal('https://git-scm.com/book/ja/v2') },
        { type: 'separator' },
        { label: '新しい版を確認…', click: send('update') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { buildMenu(); createWindow(); setupUpdater(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
