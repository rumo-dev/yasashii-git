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
  await t('公開先と分岐の不正な指定を拒否する', async () => {
    await assert.rejects(() => gh.createRelease(repo, { tag: 'v1', repository: '--bad' }), /指定/);
    await assert.rejects(() => gh.createRelease(repo, { tag: 'v1', repository: 'a/b', target: '-bad' }), /分岐/);
    await assert.rejects(() => gh.createRelease(repo, { tag: 'v1', target: 'main' }), /分岐/);
  });
  await t('公開先の指定時のみ --repo と --target を渡し、既存タグも選べる', async () => {
    const vm = require('vm');
    const { EventEmitter } = require('events');
    const calls = [];
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/gh'), 'utf8'), {
      module: mod, process, Buffer, console,
      require: (id) => id === 'child_process' ? { spawn: (cmd, args) => {
        calls.push(args);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} };
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from('https://github.com/public/downloads/releases/tag/v1')); child.emit('close', 0); });
        return child;
      } } : id === './auth-errors' ? require('../src/auth-errors') : require(id),
    });
    await mod.exports.createRelease(repo, { tag: 'v1' });
    assert.ok(calls[0].includes('--verify-tag')); assert.ok(!calls[0].includes('--repo'));
    await mod.exports.createRelease(repo, { tag: 'v1', repository: 'public/downloads', target: 'main', draft: true });
    assert.deepStrictEqual(Array.from(calls[1].slice(-5)), ['--repo', 'public/downloads', '--target', 'main', '--draft']);
    assert.ok(!calls[1].includes('--verify-tag'));
    await mod.exports.createRelease(repo, { tag: 'v1', repository: 'public/downloads' });
    assert.ok(calls[2].includes('--verify-tag'));
  });
  await t('初心者向けリリーステンプレートを作成でき、既存ファイルを保護する', () => {
    assert.ok(gh.listActionsTemplates().some((x) => x.id === 'release'));
    const result = gh.createLocalActionsWorkflow(repo, { template: 'release' });
    const { content } = gh.readLocalActionsWorkflow(repo, result.filename);
    assert.ok(content.includes('workflow_dispatch:') && content.includes('default: true'));
    assert.ok(content.includes('${{ inputs.repository }}'));
    assert.ok(content.includes('RELEASE_TOKEN') && content.includes('contents: write'));
    assert.ok(content.includes('gh "${args[@]}"'));
    assert.throws(() => gh.createLocalActionsWorkflow(repo, { template: 'release' }), /すでに/);
  });
  await t('別リポジトリへの作成では、未送信のソースやローカルタグを送らない', async () => {
    const vm = require('vm');
    const calls = [];
    const context = {
      S: { repo, settings: {}, hasRemote: false, status: { hasCommits: true, ahead: 3, files: [] } },
      saveSettings: async (patch) => { Object.assign(context.S.settings, patch); },
      refreshStatus: async () => {}, refreshAll: async () => {},
      withBusy: async (_, fn) => fn(), withBusyThrow: async (_, fn) => fn(),
      G: async (fn) => { assert.strictEqual(fn, 'releaseDraft'); return { headTags: [], commits: [], notes: '', suggested: 'v1' }; },
      GH: async (...args) => { calls.push(args); return { url: 'https://github.com/public/downloads/releases/tag/v1' }; },
      formDialog: async () => ({ repository: 'public/downloads', target: 'main', tag: 'v1', title: '', notes: '公開用の説明', draft: true }),
      confirmDialog: async () => true, modal: async () => false, h: () => ({}),
      toast: (message) => assert.fail(message), showError: (e) => { throw e; },
      doPush: () => assert.fail('ソースを送信してはいけない'),
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/release.js'), 'utf8'), context);
    assert.strictEqual(await vm.runInContext('releaseFlow()', context), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][2].repository, 'public/downloads');
    assert.strictEqual(calls[0][2].target, 'main');
    assert.strictEqual(context.S.settings.releaseDestinations[repo].repository, 'public/downloads');
    // 再起動時と同じく、保存したJSONから設定を読み直す。
    context.S.settings = JSON.parse(JSON.stringify(context.S.settings));
    context.formDialog = async ({ fields }) => {
      assert.strictEqual(fields.find((f) => f.key === 'repository').value, 'public/downloads');
      assert.strictEqual(fields.find((f) => f.key === 'target').value, 'main');
      return null;
    };
    assert.strictEqual(await vm.runInContext('releaseFlow()', context), false);
    context.S.repo = path.join(tmp, 'other-project');
    context.formDialog = async ({ fields }) => {
      assert.strictEqual(fields.find((f) => f.key === 'repository').value, '');
      assert.strictEqual(fields.find((f) => f.key === 'target').value, '');
      return { repository: 'other/releases', target: 'stable', tag: 'v2', title: '', notes: '' };
    };
    await vm.runInContext('releaseFlow()', context);
    assert.strictEqual(context.S.settings.releaseDestinations[repo].repository, 'public/downloads');
    assert.strictEqual(context.S.settings.releaseDestinations[context.S.repo].target, 'stable');
    // 空欄に戻した設定も保存し、別プロジェクトの設定は保持する。
    context.S.repo = repo;
    context.toast = () => {};
    context.formDialog = async () => ({ repository: '', target: '', tag: 'v3', title: '', notes: '' });
    await vm.runInContext('releaseFlow()', context);
    assert.strictEqual(context.S.settings.releaseDestinations[repo].repository, '');
    assert.strictEqual(context.S.settings.releaseDestinations[repo].target, '');
    assert.strictEqual(context.S.settings.releaseDestinations[path.join(tmp, 'other-project')].repository, 'other/releases');
  });
  console.log(`\n${n} 件成功`);
})();
