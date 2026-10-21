'use strict';
/**
 * アプリの自動更新（メイン側）。
 *
 * - 新しい版が出たかどうかを GitHub Releases で確認し、状態（state）を画面へ知らせる。
 * - 更新のしかたは環境で変わる：
 *     auto     … アプリの中でダウンロードして、再起動だけで入れ替える（Windows のインストーラー版 / Linux の AppImage）
 *     manual   … 新しい版のお知らせまで。ダウンロードページを開いて入れ直してもらう
 *                （署名していない Mac、Windows のポータブル版、deb 版など。自動で入れ替えられない環境）
 *     disabled … 更新を使わない（開発中に `npm start` で動かしているときなど）
 * - Electron や electron-updater に直接さわらず、渡された autoUpdater を使うので、Electron なしでテストできる。
 */
const { EventEmitter } = require('events');

/* ------------------------------ バージョン比較 ------------------------------ */
/** '1.2.3' / 'v1.2.3-beta.1' → { nums:[1,2,3], pre:['beta',1] }。読めなければ null */
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? m[4].split('.') : [] };
}

/** a が新しければ 1、同じなら 0、古ければ -1。読めない版は「同じ」として扱う（誤って更新をすすめない） */
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;   // 正式版 > 先行版（1.0.0 > 1.0.0-beta）
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/* ------------------------------ 環境の判定 ------------------------------ */
/**
 * このアプリの更新方式を決める。
 * @param {{platform:string,isPackaged:boolean,env:object,hasFeed:boolean,macSigned?:boolean}} o
 * @returns {{mode:'auto'|'manual'|'disabled', reason:string}}
 */
function detectMode({ platform, isPackaged, env = {}, hasFeed = true, macSigned = false }) {
  if (env.YG_DISABLE_UPDATE === '1') return { mode: 'disabled', reason: '更新の確認はオフにされています。' };
  if (!isPackaged) return { mode: 'disabled', reason: '開発中の実行（npm start）では、更新の確認は行いません。' };
  if (!hasFeed) return { mode: 'disabled', reason: 'このアプリには更新の配布先が設定されていません。（インストーラーを GitHub Actions で作ると設定されます）' };
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_DIR) return { mode: 'manual', reason: 'ポータブル版は、自動では入れ替えられません。' };
    return { mode: 'auto', reason: '' };
  }
  if (platform === 'linux') {
    if (env.APPIMAGE) return { mode: 'auto', reason: '' };
    return { mode: 'manual', reason: 'この形式（deb など）は、自動では入れ替えられません。' };
  }
  if (platform === 'darwin') {
    return macSigned ? { mode: 'auto', reason: '' } : { mode: 'manual', reason: '署名されていない Mac 版は、自動では入れ替えられません。' };
  }
  return { mode: 'manual', reason: '' };
}

/** electron-builder が作る app-update.yml から、配布先の GitHub リポジトリ（owner/repo）を読む */
function parseAppUpdateYml(text) {
  const get = (k) => { const m = String(text || '').match(new RegExp('^\\s*' + k + ':\\s*[\'"]?([^\'"\\r\\n#]+?)[\'"]?\\s*$', 'm')); return m ? m[1].trim() : ''; };
  const owner = get('owner'); const repo = get('repo');
  return get('provider') === 'github' && owner && repo ? { owner, repo } : null;
}

/** package.json の repository（文字列 / オブジェクト、github:o/r / https://github.com/o/r(.git) / git+https://…）から owner/repo を読む */
function parseRepository(repository) {
  const s = typeof repository === 'string' ? repository : (repository && repository.url) || '';
  const m = String(s).match(/(?:^github:|github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/* ------------------------------ 更新内容の文面 ------------------------------ */
/** electron-updater の releaseNotes（文字列 / HTML / [{version,note}]）を、画面に出せるただの文章にする */
function notesToText(notes, max = 2000) {
  let s = '';
  if (Array.isArray(notes)) s = notes.map((n) => (n && n.note ? `${n.version ? '■ ' + n.version + '\n' : ''}${n.note}` : '')).filter(Boolean).join('\n\n');
  else if (typeof notes === 'string') s = notes;
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|li|h[1-6]|div|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '・').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 更新まわりのエラーを、やさしい日本語にする */
function friendlyUpdateError(err) {
  const t = String((err && (err.message || err.code)) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|net::ERR|network|timeout|socket hang up/i.test(t)) return 'ネットワークにつながりませんでした。インターネット接続を確認してください。';
  if (/404|latest.*\.yml|No published versions|Cannot find/i.test(t)) return '更新の情報が見つかりませんでした。（公開されている新しい版がまだないようです）';
  if (/sha512|checksum|signature|verif/i.test(t)) return 'ダウンロードしたファイルを確認できませんでした。もう一度お試しください。';
  if (/403|rate limit/i.test(t)) return 'いまは更新を確認できませんでした。しばらくしてからもう一度お試しください。';
  return '更新の確認でエラーが発生しました。しばらくしてからもう一度お試しください。';
}

/* ------------------------------ 本体 ------------------------------ */
/**
 * @param {object} o
 * @param {EventEmitter & {checkForUpdates:Function,downloadUpdate:Function,quitAndInstall:Function}} o.autoUpdater electron-updater の autoUpdater
 * @param {string} o.currentVersion いまの版
 * @param {'auto'|'manual'|'disabled'} o.mode
 * @param {string} [o.reason] disabled / manual の理由
 * @param {(url:string)=>any} [o.openExternal] manual のとき、ダウンロードページを開く
 * @param {string} [o.releasePageUrl] ダウンロードページ
 */
function createUpdater({ autoUpdater, currentVersion, mode, reason = '', openExternal = () => {}, releasePageUrl = '', now = () => Date.now() }) {
  const bus = new EventEmitter();
  let state = { status: mode === 'disabled' ? 'disabled' : 'idle', mode, reason, currentVersion, version: '', notes: '', percent: 0, error: '', manual: false, checkedAt: 0, releaseUrl: releasePageUrl };
  let inFlight = null;

  const set = (patch) => { state = { ...state, ...patch }; bus.emit('state', state); return state; };
  const getState = () => state;

  if (mode !== 'disabled' && autoUpdater) {
    autoUpdater.autoDownload = false;          // ダウンロードは、本人が「更新する」を押してから
    autoUpdater.autoInstallOnAppQuit = true;   // ダウンロード済みなら、アプリを閉じるときに入れ替える
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('update-available', (info) => {
      const v = info && info.version;
      if (v && compareVersions(v, currentVersion) <= 0) return set({ status: 'uptodate', checkedAt: now() });
      set({ status: 'available', version: v || '', notes: notesToText(info && info.releaseNotes), percent: 0, error: '', checkedAt: now() });
    });
    autoUpdater.on('update-not-available', () => set({ status: 'uptodate', version: '', notes: '', error: '', checkedAt: now() }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'downloaded', percent: 100, version: (info && info.version) || state.version }));
    autoUpdater.on('error', (err) => {
      // ダウンロードに失敗したら「新しい版があります」に戻す（もう一度押せるように）。確認中の失敗は、静かに待機に戻す
      const back = state.status === 'downloading' ? 'available' : 'idle';
      set({ status: back, error: friendlyUpdateError(err) });
    });
  }

  /** 新しい版を確認する。manual=true は本人が「確認」を押したとき（失敗や「最新です」も画面に出す） */
  function check({ manual = false } = {}) {
    if (state.status === 'disabled') return Promise.resolve(state);
    if (['downloading', 'downloaded'].includes(state.status)) return Promise.resolve(state);
    if (inFlight) return inFlight;
    set({ status: 'checking', manual, error: '' });
    inFlight = (async () => {
      try {
        const r = await autoUpdater.checkForUpdates();
        // update-available / update-not-available のイベントが状態を決める。イベントなしで終わった（開発ビルドなど）ときは待機へ戻す
        if (state.status === 'checking') set({ status: r ? 'uptodate' : 'idle', checkedAt: now() });
      } catch (e) {
        set({ status: 'idle', error: friendlyUpdateError(e), checkedAt: now() });
      } finally { inFlight = null; }
      return state;
    })();
    return inFlight;
  }

  /** 「更新する」：auto はダウンロード開始、manual はダウンロードページを開く */
  async function download() {
    if (state.status !== 'available') return state;
    if (mode !== 'auto') { if (releasePageUrl) await openExternal(releasePageUrl); return state; }
    set({ status: 'downloading', percent: 0, error: '' });
    try { await autoUpdater.downloadUpdate(); }
    catch (e) { if (state.status === 'downloading') set({ status: 'available', error: friendlyUpdateError(e) }); }
    return state;
  }

  /** 「再起動して更新」：ダウンロード済みのときだけ。静かに入れ替えて、終わったらアプリを開き直す */
  function install() {
    if (state.status !== 'downloaded') return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  return { getState, check, download, install, onState: (cb) => bus.on('state', cb) };
}

module.exports = { parseVersion, compareVersions, detectMode, parseAppUpdateYml, parseRepository, notesToText, friendlyUpdateError, createUpdater };
