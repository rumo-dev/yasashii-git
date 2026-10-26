'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeProjectPath } = require('../src/path-safety');
const allowlist = require('../src/ipc-allowlist');
const recoveryGuidance = require('../renderer/recovery-guidance');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack || e); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-security-'));
const repo = path.join(tmp, 'repo');
const outside = path.join(tmp, 'outside.txt');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'inside.txt'), 'ok');
fs.writeFileSync(outside, 'outside');

console.log('パス制限と IPC 操作許可');
t('プロジェクト内の相対パスを許可', () => {
  assert.strictEqual(safeProjectPath(repo, 'inside.txt'), path.join(repo, 'inside.txt'));
});
t('親フォルダへの移動を拒否', () => {
  assert.throws(() => safeProjectPath(repo, '../outside.txt'), /プロジェクトの外/);
});
t('絶対パスを拒否', () => {
  assert.throws(() => safeProjectPath(repo, outside), /プロジェクトの外/);
});
t('プロジェクト内のシンボリックリンク経由で外へ出る操作を拒否', () => {
  const link = path.join(repo, 'outside-link.txt');
  try {
    fs.symlinkSync(outside, link, 'file');
    assert.throws(() => safeProjectPath(repo, 'outside-link.txt'), /プロジェクトの外/);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOTSUP') return;
    throw e;
  }
});
t('必要な画面操作を許可し、内部関数を拒否', () => {
  assert.ok(allowlist.git.has('status'));
  assert.ok(allowlist.git.has('stage'));
  assert.ok(allowlist.app.has('openFile'));
  assert.ok(allowlist.app.has('showInFolder'));
  assert.ok(!allowlist.git.has('run'));
  assert.ok(!allowlist.gh.has('run'));
  assert.ok(!allowlist.app.has('deleteProjectDirectory'));
});
t('エラーの種類ごとに復旧先と次の手順を案内', () => {
  const conflict = recoveryGuidance({ message: '変更のぶつかりが発生しました' });
  assert.strictEqual(conflict.view, 'changes');
  assert.match(conflict.title, /ぶつかり/);
  assert.ok(conflict.steps.some((x) => /中止/.test(x)));
  const denied = recoveryGuidance({ message: '権限がありません' });
  assert.strictEqual(denied.view, 'team');
  const auth = recoveryGuidance({ message: 'Permission denied (publickey)', kind: 'ssh' });
  assert.strictEqual(auth.view, 'github');
  const generic = recoveryGuidance({ message: '予期しないエラー' });
  assert.strictEqual(generic.view, 'changes');
});

console.log(`\n${passed} 件成功`);
