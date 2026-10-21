'use strict';
// リリースの下書き（src/git.js の releaseDraft）と、リリース作成の入力チェック。 実行: node test/release.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-rel-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp; process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = path.join(tmp, '.gitconfig');
const git = require('../src/git'); const gh = require('../src/gh');
const sh = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const repo = path.join(tmp, 'p'); fs.mkdirSync(repo);
const commit = (msg) => { fs.writeFileSync(path.join(repo, 'f.txt'), msg + Math.random()); sh('add', '.'); sh('commit', '-qm', msg); };
let n = 0;
async function t(name, fn) { try { await fn(); n++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; } }

(async () => {
  sh('init', '-q', '-b', 'main'); sh('config', 'user.name', 'T'); sh('config', 'user.email', 't@e.com');
  await t('記録がなくてもエラーにならず、v0.1.0 を提案する', async () => {
    const d = await git.releaseDraft(repo);
    assert.strictEqual(d.suggested, 'v0.1.0'); assert.strictEqual(d.lastTag, null); assert.deepStrictEqual(d.commits, []); assert.strictEqual(d.notes, '');
  });
  commit('最初の記録'); commit('ログイン画面を追加');
  await t('目印がなければ、全記録からリリースノートの下書きを作る', async () => {
    const d = await git.releaseDraft(repo);
    assert.strictEqual(d.suggested, 'v0.1.0');
    assert.deepStrictEqual(d.commits.map((c) => c.subject), ['ログイン画面を追加', '最初の記録']);
    assert.ok(d.notes.includes('- ログイン画面を追加') && d.notes.startsWith('## 変更点'));
  });
  sh('tag', 'v1.2.9'); sh('tag', 'v1.10.0'); sh('tag', 'old-release'); sh('tag', 'v1.2.10');
  commit('バグを直した'); commit('文言を修正');
  await t('次のバージョンは、いちばん新しい「数字の順」の目印から決める（v1.10.0 > v1.2.10）', async () => {
    const d = await git.releaseDraft(repo);
    assert.strictEqual(d.lastTag, 'v1.10.0'); assert.strictEqual(d.suggested, 'v1.10.1');
  });
  await t('前のバージョンからの記録だけが、リリースノートに入る', async () => {
    const d = await git.releaseDraft(repo);
    assert.deepStrictEqual(d.commits.map((c) => c.subject), ['文言を修正', 'バグを直した']);
    assert.ok(!d.notes.includes('最初の記録'));
  });
  await t('いまの記録にすでに目印があれば、headTags に出る', async () => {
    sh('tag', 'v9.9.9'); const d = await git.releaseDraft(repo);
    assert.ok(d.headTags.includes('v9.9.9'));
  });
  await t('「-」で始まるバージョン名・空白入りは作れない', async () => {
    await assert.rejects(() => git.createTag(repo, '-bad'), /使えません/);
    await assert.rejects(() => gh.createRelease(repo, { tag: '-x' }), /使えません/);
    await assert.rejects(() => gh.createRelease(repo, { tag: 'v 1' }), /使えません/);
    await assert.rejects(() => gh.createRelease(repo, { tag: '' }), /入力/);
  });
  await t('同じ名前のリリースがあるときの文面', () => {
    assert.ok(/すでに/.test(gh.friendly('a release with the same tag name already exists: v1.0.0')));
  });
  console.log(`\n${n} 件成功`);
})();
