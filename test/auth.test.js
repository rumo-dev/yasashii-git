'use strict';
// 「ログイン切れ／SSH鍵エラー」の見分け（src/auth-errors.js）と、git / gh のエラーに付く kind のテスト。 実行: node test/auth.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-auth-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = path.join(tmp, '.gitconfig');
const { classifyAuth } = require('../src/auth-errors');
const git = require('../src/git');
const gh = require('../src/gh');

let n = 0;
async function t(name, fn) {
  try { await fn(); n++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
}

(async () => {
  console.log('認証エラーの見分け');
  await t('トークン切れ・認証失敗 → auth', () => {
    for (const s of [
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'gh: Bad credentials (HTTP 401)',
      'fatal: unable to access \'https://github.com/a/b.git/\': The requested URL returned error: 401',
      'remote: Support for password authentication was removed on August 13, 2021.',
      'error: The token in GITHUB_TOKEN is invalid.',
      'To get started with GitHub CLI, please run:  gh auth login',
    ]) assert.strictEqual(classifyAuth(s), 'auth', s);
  });
  await t('SSH鍵・ホスト鍵の失敗 → ssh', () => {
    for (const s of [
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'Host key verification failed.\nfatal: Could not read from remote repository.',
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
      'Load key "/home/a/.ssh/id_rsa": bad permissions',
    ]) assert.strictEqual(classifyAuth(s), 'ssh', s);
  });
  await t('workflow 権限の不足 → scope（「更新が足りない」と取り違えない）', () => {
    const raw = "To https://github.com/a/b.git\n ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/release.yml` without `workflow` scope)\nerror: failed to push some refs to 'https://github.com/a/b.git'";
    assert.strictEqual(classifyAuth(raw), 'scope');
    assert.ok(/ワークフロー/.test(git.friendly(raw)) && !/最新を取り込む/.test(git.friendly(raw)));
  });
  await t('サーバーに拒否された理由は、そのまま添える。「更新が足りない」は本当にそのときだけ', () => {
    const rej = "! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'x'";
    assert.ok(/protected branch hook declined/.test(git.friendly(rej)) && !/最新を取り込む/.test(git.friendly(rej)));
    assert.ok(/最新を取り込む/.test(git.friendly('! [rejected] main -> main (fetch first)\nerror: failed to push some refs')));
    assert.ok(/最新を取り込む/.test(git.friendly('Updates were rejected because the remote contains work that you do not have locally.')));
  });
  await t('ネットワーク断・権限不足(403)・ぶつかり・空 → 対象外', () => {
    for (const s of [
      "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: Connection timed out",
      "remote: Permission to a/b.git denied to c.\nfatal: unable to access: The requested URL returned error: 403",
      'gh: Resource not accessible by integration (HTTP 403)',
      'CONFLICT (content): Merge conflict in a.txt', 'Repository not found.', '', null, undefined,
    ]) assert.strictEqual(classifyAuth(s), '', String(s));
  });
  await t('ネットワークの語が混ざっていれば、認証語があっても対象外', () => {
    assert.strictEqual(classifyAuth('Authentication failed ... Could not resolve host: github.com'), '');
  });

  console.log('エラーへの kind の付与');
  await t('GitError / GhError は detail から kind を持つ', () => {
    assert.strictEqual(new git.GitError('m', 'fatal: Authentication failed for x').kind, 'auth');
    assert.strictEqual(new git.GitError('m', 'Permission denied (publickey).').kind, 'ssh');
    assert.strictEqual(new git.GitError('m', 'CONFLICT').kind, '');
    assert.strictEqual(new gh.GhError('m', 'gh: Bad credentials (HTTP 401)').kind, 'auth');
    assert.strictEqual(new gh.GhError('m', 'HTTP 403 Forbidden').kind, '');
  });
  await t('SSH鍵のエラーは、HTTPS への切り替えを案内する文面になる', () => {
    assert.ok(/HTTPS/.test(git.friendly('git@github.com: Permission denied (publickey).')));
    assert.ok(/ログイン/.test(git.friendly('fatal: Authentication failed for x')));
  });
  await t('本物の git：認証が必要なサーバーへの取得は kind=auth で失敗する', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end('no'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/a/b.git`;
    const repo = path.join(tmp, 'p'); fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: repo });
    try {
      await assert.rejects(() => git.fetch(repo), (e) => { assert.strictEqual(e.kind, 'auth', e.message + ' / ' + e.detail); assert.ok(/ログイン/.test(e.message)); return true; });
    } finally { srv.close(); }
  });
  await t('本物の git：つながらないサーバーは kind が空（ログインし直しの案内を出さない）', async () => {
    const repo = path.join(tmp, 'p'); execFileSync('git', ['remote', 'set-url', 'origin', 'http://127.0.0.1:1/a/b.git'], { cwd: repo });
    await assert.rejects(() => git.fetch(repo), (e) => { assert.strictEqual(e.kind, '', e.detail); return true; });
  });

  console.log(`\n${n} 件成功`);
})();
