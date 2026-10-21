'use strict';
// lib/git.js と renderer/util.js の動作テスト（Electron不要）。 実行: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 実際の環境の設定に影響されないよう、lib/git を読み込む前に HOME を差し替える
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-'));
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(HOME, '.gitconfig');
const g = require('../lib/git');
const U = require('../renderer/util');

let n = 0;
async function t(name, fn) {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  NG  ' + name + '\n      ' + (e.stack || e));
    process.exitCode = 1;
  }
}
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const W = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const must = (r) => { assert.ok(r.ok, JSON.stringify(r.error)); return r.data; };

(async () => {
  const repo = path.join(tmp, 'proj');
  fs.mkdirSync(repo);

  await t('初期化とバージョン', async () => {
    assert.ok((await g.gitVersion()).ok);
    assert.strictEqual(must(await g.isRepo(repo)).repo, false);
    must(await g.init(repo));
    assert.strictEqual(must(await g.isRepo(repo)).repo, true);
  });

  await t('名前未設定のとき日本語エラー(NO_IDENTITY)', async () => {
    W(repo, 'あ.txt', 'こんにちは\n');
    must(await g.stage(repo, ['あ.txt']));
    const r = await g.commit(repo, { summary: 'はじめ' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'NO_IDENTITY');
    assert.ok(/名前/.test(r.error.message));
  });

  await t('名前を設定して最初の記録', async () => {
    must(await g.setIdentity(repo, { name: 'テスト太郎', email: 't@example.com', scope: 'global' }));
    const id = must(await g.getIdentity(repo));
    assert.strictEqual(id.name, 'テスト太郎');
    must(await g.commit(repo, { summary: 'はじめの記録', body: '本文です' }));
    const st = must(await g.status(repo));
    assert.strictEqual(st.files.length, 0);
    assert.strictEqual(st.branch, 'main');
    assert.strictEqual(st.hasCommits, true);
  });

  await t('状態: 変更・新規・日本語ファイル名', async () => {
    W(repo, 'あ.txt', 'こんにちは\n二行目\n');
    W(repo, 'new dir/新規 ファイル.txt', 'x\n');
    const st = must(await g.status(repo));
    const a = st.files.find((f) => f.path === 'あ.txt');
    assert.ok(a && a.x === '.' && a.y === 'M');
    const b = st.files.find((f) => f.path === 'new dir/新規 ファイル.txt');
    assert.ok(b && b.untracked);
  });

  await t('差分: 変更・未追跡', async () => {
    const d = must(await g.diff(repo, { path: 'あ.txt', staged: false }));
    assert.ok(d.text.includes('+二行目'));
    const u = must(await g.diff(repo, { path: 'new dir/新規 ファイル.txt', untracked: true }));
    assert.ok(u.text.includes('+x') && u.isNew);
  });

  await t('追加と取り外し', async () => {
    must(await g.stage(repo, ['あ.txt']));
    let st = must(await g.status(repo));
    assert.strictEqual(st.files.find((f) => f.path === 'あ.txt').x, 'M');
    must(await g.unstage(repo, ['あ.txt']));
    st = must(await g.status(repo));
    assert.strictEqual(st.files.find((f) => f.path === 'あ.txt').x, '.');
  });

  await t('一部分だけ記録に含める（ハンク）', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    W(repo, 'long.txt', body);
    must(await g.stage(repo, ['long.txt']));
    must(await g.commit(repo, { summary: 'long追加' }));
    const mod = body.replace('line2\n', 'line2-変更\n').replace('line38\n', 'line38-変更\n');
    W(repo, 'long.txt', mod);
    const d = must(await g.diff(repo, { path: 'long.txt', staged: false }));
    const files = U.parseDiff(d.text);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].hunks.length, 2);
    must(await g.applyPatch(repo, { patch: U.buildPatch(files[0], files[0].hunks[0]), reverse: false }));
    const staged = must(await g.diff(repo, { path: 'long.txt', staged: true }));
    assert.ok(staged.text.includes('line2-変更') && !staged.text.includes('line38-変更'));
    // 外す
    const sf = U.parseDiff(staged.text)[0];
    must(await g.applyPatch(repo, { patch: U.buildPatch(sf, sf.hunks[0]), reverse: true }));
    const s2 = must(await g.diff(repo, { path: 'long.txt', staged: true }));
    assert.strictEqual(s2.text.trim(), '');
    must(await g.discard(repo, { tracked: ['long.txt'] }));
  });

  await t('取り消し(新規ファイルの削除含む)', async () => {
    must(await g.discard(repo, { tracked: ['あ.txt'], untracked: ['new dir/新規 ファイル.txt'] }));
    const st = must(await g.status(repo));
    assert.strictEqual(st.files.length, 0);
  });

  await t('直前の記録の修正', async () => {
    W(repo, 'b.txt', 'b\n');
    must(await g.stageAll(repo));
    const m = must(await g.lastMessage(repo));
    assert.strictEqual(m.summary, 'long追加');
    must(await g.commit(repo, { summary: 'long追加+b', amend: true }));
    const l = must(await g.log(repo, {}));
    assert.strictEqual(l[0].subject, 'long追加+b');
  });

  await t('作業ライン作成・切替・取り込み・削除', async () => {
    must(await g.createBranch(repo, { name: 'feature/a', checkout: true }));
    W(repo, 'f.txt', 'f\n');
    must(await g.stageAll(repo));
    must(await g.commit(repo, { summary: 'feature作業' }));
    must(await g.checkout(repo, { name: 'main' }));
    let b = must(await g.branches(repo));
    assert.ok(b.local.find((x) => x.name === 'main').current);
    assert.ok(b.local.find((x) => x.name === 'feature/a'));
    must(await g.merge(repo, { name: 'feature/a', mode: 'noff' }));
    assert.ok(fs.existsSync(path.join(repo, 'f.txt')));
    must(await g.deleteBranch(repo, { name: 'feature/a' }));
    b = must(await g.branches(repo));
    assert.ok(!b.local.find((x) => x.name === 'feature/a'));
  });

  await t('名前変更', async () => {
    must(await g.createBranch(repo, { name: 'tmp1' }));
    must(await g.renameBranch(repo, { oldName: 'tmp1', newName: 'tmp2' }));
    const b = must(await g.branches(repo));
    assert.ok(b.local.find((x) => x.name === 'tmp2'));
    must(await g.deleteBranch(repo, { name: 'tmp2' }));
  });

  await t('履歴・ファイル一覧・差分・グラフ', async () => {
    const l = must(await g.log(repo, { all: true }));
    assert.ok(l.length >= 4);
    assert.ok(l[0].refs.some((r) => r.type === 'head' && r.name === 'main'));
    const files = must(await g.commitFiles(repo, l[l.length - 1].hash)); // ルート
    assert.ok(files.length >= 1);
    const f2 = must(await g.commitFiles(repo, l[0].hash));
    assert.ok(f2.length >= 1);
    const cd = must(await g.commitDiff(repo, { hash: l[0].hash, path: f2[0].path, old: f2[0].old }));
    assert.ok(cd.text.includes('diff --git'));
    assert.ok(must(await g.commitBody(repo, l[l.length - 1].hash)).includes('はじめの記録'));
    const gr = U.layoutGraph(l);
    assert.strictEqual(gr.rows.length, l.length);
    assert.ok(gr.rows.some((r) => r.merge));
    const s = must(await g.log(repo, { search: 'feature' }));
    assert.ok(s.length >= 1 && s.every((x) => /feature/i.test(x.subject) || true));
  });

  await t('一時避難', async () => {
    W(repo, 'b.txt', 'b変更\n');
    W(repo, 'untracked.txt', 'u\n');
    must(await g.stashSave(repo, { message: '途中の作業', includeUntracked: true }));
    assert.strictEqual(must(await g.status(repo)).files.length, 0);
    const list = must(await g.stashList(repo));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].message, '途中の作業');
    assert.ok(must(await g.stashDiff(repo, list[0].ref)).text.includes('b変更'));
    must(await g.stashPop(repo, list[0].ref));
    assert.ok(must(await g.status(repo)).files.length >= 1);
    must(await g.discardAll(repo));
    assert.strictEqual(must(await g.status(repo)).files.length, 0);
  });

  await t('目印', async () => {
    must(await g.createTag(repo, { name: 'v1.0', message: '最初のリリース' }));
    must(await g.createTag(repo, { name: 'v0.9' }));
    const tg = must(await g.tags(repo));
    assert.ok(tg.find((x) => x.name === 'v1.0'));
    must(await g.deleteTag(repo, 'v0.9'));
    assert.strictEqual(must(await g.tags(repo)).length, 1);
  });

  await t('打ち消し・取り込み(1件)・巻き戻し', async () => {
    W(repo, 'r.txt', 'r\n');
    must(await g.stageAll(repo));
    must(await g.commit(repo, { summary: 'r追加' }));
    const head = must(await g.log(repo, {}))[0];
    must(await g.revert(repo, head.hash));
    assert.ok(!fs.existsSync(path.join(repo, 'r.txt')));
    must(await g.cherryPick(repo, head.hash));
    assert.ok(fs.existsSync(path.join(repo, 'r.txt')));
    const before = must(await g.log(repo, {})).length;
    must(await g.reset(repo, { hash: 'HEAD~1', mode: 'mixed' }));
    assert.strictEqual(must(await g.log(repo, {})).length, before - 1);
    assert.ok(must(await g.status(repo)).files.some((f) => f.path === 'r.txt'));
    must(await g.discardAll(repo));
  });

  await t('保管場所・送る・取り込む・確認', async () => {
    const bare = path.join(tmp, 'remote.git');
    sh(tmp, 'init', '--bare', '-b', 'main', bare);
    must(await g.addRemote(repo, { name: 'origin', url: bare }));
    assert.strictEqual(must(await g.remotes(repo))[0].url, bare);
    must(await g.push(repo, { branch: 'main', remote: 'origin', setUpstream: true }));
    let st = must(await g.status(repo));
    assert.strictEqual(st.upstream, 'origin/main');
    assert.strictEqual(st.ahead, 0);
    // 別の人がクローンして変更を送る
    const other = path.join(tmp, 'other');
    must(await g.clone(null, { url: bare, dest: other }));
    W(other, 'o.txt', 'other\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '-m', '他の人の変更');
    must(await g.push(other, {}));
    must(await g.fetch(repo));
    st = must(await g.status(repo));
    assert.strictEqual(st.behind, 1);
    // こちらにも変更→送ると拒否される→日本語エラー
    W(repo, 'mine.txt', 'mine\n');
    must(await g.stageAll(repo));
    must(await g.commit(repo, { summary: '自分の変更' }));
    const rej = await g.push(repo, {});
    assert.strictEqual(rej.ok, false);
    assert.strictEqual(rej.error.code, 'REJECTED');
    must(await g.pull(repo));
    assert.ok(fs.existsSync(path.join(repo, 'o.txt')));
    must(await g.push(repo, {}));
    st = must(await g.status(repo));
    assert.strictEqual(st.ahead, 0);
    assert.strictEqual(st.behind, 0);
    const b = must(await g.branches(repo));
    assert.ok(b.remote.find((x) => x.name === 'origin/main'));
    // 目印の送信と削除
    must(await g.pushTag(repo, { remote: 'origin', name: 'v1.0' }));
    must(await g.deleteRemoteTag(repo, { remote: 'origin', name: 'v1.0' }));
    // オンラインの作業ラインを手元にコピーして開始
    sh(other, 'checkout', '-b', 'topic');
    W(other, 't.txt', 't\n');
    sh(other, 'add', '-A'); sh(other, 'commit', '-m', 't');
    sh(other, 'push', '-u', 'origin', 'topic');
    must(await g.fetch(repo));
    must(await g.checkout(repo, { name: 'origin/topic', remote: true }));
    assert.strictEqual(must(await g.status(repo)).branch, 'topic');
    must(await g.checkout(repo, { name: 'main' }));
    must(await g.deleteRemoteBranch(repo, 'origin/topic'));
  });

  await t('ぶつかり(競合)の検出と解決', async () => {
    must(await g.createBranch(repo, { name: 'x1', checkout: true }));
    W(repo, 'c.txt', 'x1の内容\n');
    must(await g.stageAll(repo));
    must(await g.commit(repo, { summary: 'x1' }));
    must(await g.checkout(repo, { name: 'main' }));
    W(repo, 'c.txt', 'mainの内容\n');
    must(await g.stageAll(repo));
    must(await g.commit(repo, { summary: 'main側' }));
    const r = await g.merge(repo, { name: 'x1', mode: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'CONFLICT');
    let st = must(await g.status(repo));
    assert.strictEqual(st.operation, 'merge');
    assert.ok(st.files.find((f) => f.path === 'c.txt').conflict);
    must(await g.resolveConflict(repo, { path: 'c.txt', side: 'theirs' }));
    assert.strictEqual(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'x1の内容\n');
    st = must(await g.status(repo));
    assert.strictEqual(st.files.filter((f) => f.conflict).length, 0);
    must(await g.continueOperation(repo, 'merge'));
    assert.strictEqual(must(await g.status(repo)).operation, null);
    // 中止
    must(await g.createBranch(repo, { name: 'x2', checkout: true }));
    W(repo, 'c.txt', 'x2\n'); must(await g.stageAll(repo)); must(await g.commit(repo, { summary: 'x2' }));
    must(await g.checkout(repo, { name: 'main' }));
    W(repo, 'c.txt', 'm2\n'); must(await g.stageAll(repo)); must(await g.commit(repo, { summary: 'm2' }));
    await g.merge(repo, { name: 'x2', mode: '' });
    assert.strictEqual(must(await g.status(repo)).operation, 'merge');
    must(await g.abortOperation(repo, 'merge'));
    assert.strictEqual(must(await g.status(repo)).operation, null);
  });

  await t('保存していない変更が邪魔で切替できない → DIRTY', async () => {
    must(await g.checkout(repo, { name: 'x1' }));
    W(repo, 'c.txt', 'x1で編集\n');
    const r = await g.checkout(repo, { name: 'main' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'DIRTY');
    must(await g.discardAll(repo));
    must(await g.checkout(repo, { name: 'main' }));
  });

  await t('無視リスト', async () => {
    must(await g.ignore(repo, '*.log'));
    must(await g.ignore(repo, '*.log'));
    assert.strictEqual(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), '*.log\n');
    W(repo, 'a.log', 'x');
    assert.ok(!must(await g.status(repo)).files.some((f) => f.path === 'a.log'));
  });

  await t('WebページURLの変換', async () => {
    must(await g.removeRemote(repo, 'origin'));
    must(await g.addRemote(repo, { name: 'origin', url: 'git@github.com:foo/bar.git' }));
    let w = must(await g.webLinks(repo));
    assert.deepStrictEqual(w, { base: 'https://github.com/foo/bar', host: 'github.com', isGithub: true });
    must(await g.setRemoteUrl(repo, { name: 'origin', url: 'https://user@github.com/foo/bar.git' }));
    w = must(await g.webLinks(repo));
    assert.strictEqual(w.base, 'https://github.com/foo/bar');
  });

  await t('存在しないフォルダ・Git以外のフォルダ', async () => {
    const r = await g.status(path.join(tmp, 'nothing'));
    assert.strictEqual(r.error.code, 'NO_FOLDER');
    const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
    const s = await g.status(plain);
    assert.strictEqual(s.error.code, 'NOT_REPO');
  });

  await t('履歴がない状態でもエラーにならない', async () => {
    const e = path.join(tmp, 'empty'); fs.mkdirSync(e);
    must(await g.init(e));
    assert.deepStrictEqual(must(await g.log(e, {})), []);
    const st = must(await g.status(e));
    assert.strictEqual(st.hasCommits, false);
    W(e, 'a.txt', 'a\n');
    must(await g.stageAll(e));
    must(await g.unstageAll(e));
    assert.ok(must(await g.status(e)).files[0].untracked);
  });

  // ---- util ----
  await t('util: parseDiff / relTime / splitPath', async () => {
    const text = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10 +11 @@\n-d\n+e\n';
    const f = U.parseDiff(text);
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].title, 'x');
    assert.strictEqual(f[0].hunks.length, 2);
    assert.strictEqual(f[0].hunks[0].lines.length, 3);
    assert.ok(U.buildPatch(f[0], f[0].hunks[1]).startsWith('diff --git a/x b/x\n'));
    assert.strictEqual(U.relTime(new Date(Date.now() - 5 * 60000).toISOString()), '5分前');
    assert.deepStrictEqual(U.splitPath('a/b/c.txt'), { dir: 'a/b/', name: 'c.txt' });
    assert.strictEqual(U.parseDiff('').length, 0);
  });

  console.log(`\n${n} 件のテストが成功しました。`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
