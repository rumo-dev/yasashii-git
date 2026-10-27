'use strict';
// 自動更新（src/updater.js）のテスト。Electron なしで、偽の autoUpdater を使って確認する。 実行: node test/updater.test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const U = require('../src/updater');

let n = 0;
async function t(name, fn) {
  try { await fn(); n++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
}

function fakeUpdater(over = {}) {
  const a = new EventEmitter();
  a.calls = [];
  a.checkForUpdates = over.check || (async () => { a.calls.push('check'); a.emit('update-not-available', { version: '0.1.0' }); return { updateInfo: {} }; });
  a.downloadUpdate = over.download || (async () => { a.calls.push('download'); a.emit('download-progress', { percent: 40.4 }); a.emit('update-downloaded', { version: '0.2.0' }); });
  a.quitAndInstall = (...args) => a.calls.push(['install', ...args]);
  return a;
}
const make = (au, extra = {}) => U.createUpdater({ autoUpdater: au, currentVersion: '0.1.0', mode: 'auto', releasePageUrl: 'https://github.com/o/r/releases/latest', ...extra });

(async () => {
  console.log('バージョン比較');
  await t('新しい・同じ・古い', () => {
    assert.strictEqual(U.compareVersions('0.2.0', '0.1.0'), 1);
    assert.strictEqual(U.compareVersions('0.1.0', '0.1.0'), 0);
    assert.strictEqual(U.compareVersions('0.1.0', '0.1.1'), -1);
    assert.strictEqual(U.compareVersions('1.0.0', '0.9.9'), 1);
    assert.strictEqual(U.compareVersions('0.10.0', '0.9.0'), 1, '10 は 9 より新しい（文字列比較にしない）');
    assert.strictEqual(U.compareVersions('v1.2.3', '1.2.3'), 0, 'v つきも読める');
  });
  await t('先行版は正式版より古い', () => {
    assert.strictEqual(U.compareVersions('1.0.0', '1.0.0-beta.1'), 1);
    assert.strictEqual(U.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
    assert.strictEqual(U.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  });
  await t('読めない版は「同じ」扱い（誤って更新をすすめない）', () => {
    assert.strictEqual(U.compareVersions('abc', '1.0.0'), 0);
    assert.strictEqual(U.compareVersions('', '1.0.0'), 0);
    assert.strictEqual(U.compareVersions(undefined, '1.0.0'), 0);
  });

  console.log('更新方式の判定');
  await t('Windows インストーラー版・Linux AppImage は自動、それ以外は手動', () => {
    const base = { isPackaged: true, hasFeed: true };
    assert.strictEqual(U.detectMode({ ...base, platform: 'win32', env: {} }).mode, 'auto');
    assert.strictEqual(U.detectMode({ ...base, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }).mode, 'manual');
    assert.strictEqual(U.detectMode({ ...base, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } }).mode, 'auto');
    assert.strictEqual(U.detectMode({ ...base, platform: 'linux', env: {} }).mode, 'manual');
    assert.strictEqual(U.detectMode({ ...base, platform: 'darwin', env: {} }).mode, 'manual', '署名なしの Mac は手動');
    assert.strictEqual(U.detectMode({ ...base, platform: 'darwin', env: {}, macSigned: true }).mode, 'auto');
  });
  await t('開発中・配布先なし・明示オフは更新しない', () => {
    assert.strictEqual(U.detectMode({ platform: 'win32', isPackaged: false, env: {}, hasFeed: true }).mode, 'disabled');
    assert.strictEqual(U.detectMode({ platform: 'win32', isPackaged: true, env: {}, hasFeed: false }).mode, 'disabled');
    assert.strictEqual(U.detectMode({ platform: 'win32', isPackaged: true, env: { YG_DISABLE_UPDATE: '1' }, hasFeed: true }).mode, 'disabled');
    assert.ok(U.detectMode({ platform: 'win32', isPackaged: false, env: {}, hasFeed: true }).reason, '理由の文章がある');
  });

  console.log('配布先の読み取り');
  await t('app-update.yml から owner/repo を読む', () => {
    assert.deepStrictEqual(U.parseAppUpdateYml('owner: taro\nrepo: yasashii-git\nprovider: github\nupdaterCacheDirName: yasashii-git-updater\n'), { owner: 'taro', repo: 'yasashii-git' });
    assert.deepStrictEqual(U.parseAppUpdateYml('provider: github\nowner: "o"\nrepo: \'r\'\r\n'), { owner: 'o', repo: 'r' });
    assert.strictEqual(U.parseAppUpdateYml('provider: generic\nurl: https://x/\n'), null);
    assert.strictEqual(U.parseAppUpdateYml(''), null);
  });
  await t('package.json の repository から owner/repo を読む', () => {
    for (const r of ['github:a/b', 'https://github.com/a/b', 'https://github.com/a/b.git', 'git+https://github.com/a/b.git', { type: 'git', url: 'git@github.com:a/b.git' }]) assert.deepStrictEqual(U.parseRepository(r), { owner: 'a', repo: 'b' }, JSON.stringify(r));
    assert.strictEqual(U.parseRepository(undefined), null);
    assert.strictEqual(U.parseRepository('https://example.com/a/b'), null);
  });

  console.log('更新内容の文面');
  await t('HTML・配列の更新内容を、ただの文章にする', () => {
    assert.strictEqual(U.notesToText('<h2>v1</h2><ul><li>新機能</li><li>修正 &amp; 改善</li></ul>'), 'v1\n・新機能\n・修正 & 改善');
    assert.ok(U.notesToText([{ version: '0.2.0', note: '<p>A</p>' }, { version: '0.1.5', note: 'B' }]).includes('■ 0.2.0'));
    assert.strictEqual(U.notesToText(null), '');
    assert.ok(U.notesToText('x'.repeat(5000)).length <= 2001, '長すぎたら切る');
    assert.ok(!U.notesToText('<script>alert(1)</script>ok').includes('<'), 'タグは残さない');
  });
  await t('エラーはやさしい日本語になる', () => {
    assert.ok(/ネットワーク/.test(U.friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))));
    assert.ok(/見つかりませんでした/.test(U.friendlyUpdateError(new Error('Cannot find latest.yml in the latest release artifacts (HTTP 404)'))));
    assert.ok(/確認できませんでした/.test(U.friendlyUpdateError(new Error('sha512 checksum mismatch'))));
    assert.ok(U.friendlyUpdateError(new Error('???')).length > 5);
  });

  console.log('更新の流れ');
  await t('新しい版が無ければ「最新」', async () => {
    const au = fakeUpdater(); const u = make(au);
    const st = await u.check({ manual: true });
    assert.strictEqual(st.status, 'uptodate');
    assert.strictEqual(st.manual, true);
    assert.strictEqual(au.autoDownload, false, '勝手にダウンロードしない');
  });
  await t('新しい版が見つかる → 状態に版と更新内容が入り、通知される', async () => {
    const au = fakeUpdater({ check: async () => { au.emit('update-available', { version: '0.2.0', releaseNotes: '<p>直しました</p>' }); return {}; } });
    const u = make(au); const seen = [];
    u.onState((s) => seen.push(s.status));
    const st = await u.check();
    assert.strictEqual(st.status, 'available');
    assert.strictEqual(st.version, '0.2.0');
    assert.strictEqual(st.notes, '直しました');
    assert.deepStrictEqual(seen, ['checking', 'available']);
  });
  await t('同じ版・古い版が返ってきても「更新あり」にしない', async () => {
    for (const v of ['0.1.0', '0.0.9']) {
      const au = fakeUpdater({ check: async () => { au.emit('update-available', { version: v }); return {}; } });
      assert.strictEqual((await make(au).check()).status, 'uptodate', v);
    }
  });
  await t('更新する → ダウンロード → 準備完了 → 再起動して入れ替え', async () => {
    const au = fakeUpdater({ check: async () => { au.emit('update-available', { version: '0.2.0' }); return {}; } });
    const u = make(au); const seen = [];
    u.onState((s) => seen.push(s.status + (s.status === 'downloading' ? ':' + s.percent : '')));
    await u.check();
    assert.strictEqual(u.install(), false, '準備前は入れ替えない');
    await u.download();
    assert.strictEqual(u.getState().status, 'downloaded');
    assert.ok(seen.includes('downloading:40'), '進み具合が届く: ' + seen);
    assert.strictEqual(u.install(), true);
    assert.deepStrictEqual(au.calls.pop(), ['install', true, true], '静かに入れ替えて、終わったら開き直す');
  });
  await t('ダウンロード中・済みのときは、確認し直さない', async () => {
    const au = fakeUpdater({ check: async () => { au.calls.push('check'); au.emit('update-available', { version: '0.2.0' }); return {}; } });
    const u = make(au); await u.check(); await u.download();
    const before = au.calls.filter((c) => c === 'check').length;
    await u.check();
    assert.strictEqual(au.calls.filter((c) => c === 'check').length, before);
    assert.strictEqual(u.getState().status, 'downloaded');
  });
  await t('確認が重なっても、実際の確認は1回だけ', async () => {
    let count = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const au = fakeUpdater({ check: async () => { count++; await gate; au.emit('update-not-available', {}); return {}; } });
    const u = make(au);
    const p1 = u.check(); const p2 = u.check();
    release(); await Promise.all([p1, p2]);
    assert.strictEqual(count, 1);
  });
  await t('確認に失敗しても、止まらず待機に戻り、理由が入る', async () => {
    const au = fakeUpdater({ check: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
    const u = make(au);
    const st = await u.check({ manual: true });
    assert.strictEqual(st.status, 'idle');
    assert.ok(/ネットワーク/.test(st.error));
    assert.strictEqual((await u.check()).status, 'idle', 'もう一度確認できる');
  });
  await t('ダウンロードに失敗したら「新しい版があります」に戻り、もう一度押せる', async () => {
    let fail = true;
    const au = fakeUpdater({ check: async () => { au.emit('update-available', { version: '0.2.0' }); return {}; },
      download: async () => { if (fail) { au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')); throw new Error('net::ERR_INTERNET_DISCONNECTED'); } au.emit('update-downloaded', { version: '0.2.0' }); } });
    const u = make(au); await u.check(); await u.download();
    assert.strictEqual(u.getState().status, 'available');
    assert.ok(u.getState().error);
    fail = false; await u.download();
    assert.strictEqual(u.getState().status, 'downloaded');
    assert.strictEqual(u.getState().error, '');
  });
  await t('手動方式：更新するとダウンロードページを開くだけ（アプリ内ではダウンロードしない）', async () => {
    const au = fakeUpdater({ check: async () => { au.emit('update-available', { version: '0.2.0' }); return {}; } });
    const opened = [];
    const u = make(au, { mode: 'manual', openExternal: (url) => opened.push(url) });
    await u.check(); await u.download();
    assert.deepStrictEqual(opened, ['https://github.com/o/r/releases/latest']);
    assert.ok(!au.calls.includes('download'));
    assert.strictEqual(u.getState().status, 'available');
  });
  await t('無効（開発中など）：何も確認しない', async () => {
    const au = fakeUpdater(); const u = make(au, { mode: 'disabled', reason: '開発中' });
    const st = await u.check({ manual: true });
    assert.strictEqual(st.status, 'disabled'); assert.strictEqual(st.reason, '開発中');
    assert.deepStrictEqual(au.calls, []);
    assert.strictEqual(u.install(), false);
  });

  await t('自動確認の間隔：起動時・間隔変更・停止・再開・確認失敗後の継続', async () => {
    const { intervalMinutes, createUpdateSchedule } = require('../src/update-schedule');
    for (const value of [15, 30, 60, 360, 720, 1440]) assert.strictEqual(intervalMinutes(value), value);
    for (const value of [undefined, null, 0, -1, 'bad', 1000000]) assert.strictEqual(intervalMinutes(value), 60);
    let checks = 0;
    const timers = new Map();
    let id = 0;
    const scheduler = createUpdateSchedule({
      check: async () => { checks++; throw new Error('offline'); },
      setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
      clearTimer: (key) => timers.delete(key),
    });
    const delay = () => { assert.strictEqual(timers.size, 1); return [...timers.values()][0].delay; };
    const fire = async () => {
      const [key, timer] = [...timers.entries()][0]; timers.delete(key); timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    };
    scheduler.configure({}, { startup: true });
    assert.strictEqual(delay(), 15000);
    await fire(); assert.strictEqual(checks, 1); assert.strictEqual(delay(), 3600000);
    scheduler.configure({ autoUpdateCheckMin: 30 });
    assert.strictEqual(delay(), 1800000);
    await fire(); assert.strictEqual(checks, 2); assert.strictEqual(delay(), 1800000);
    scheduler.configure({ autoUpdateCheck: false, autoUpdateCheckMin: 30 });
    assert.strictEqual(timers.size, 0);
    scheduler.configure({ autoUpdateCheck: false }, { startup: true });
    assert.strictEqual(timers.size, 0);
    scheduler.configure({ autoUpdateCheck: true, autoUpdateCheckMin: 1440 });
    assert.strictEqual(delay(), 86400000);
    scheduler.stop(); assert.strictEqual(timers.size, 0);
  });

  console.log(`\n${n} 件成功`);
})();
