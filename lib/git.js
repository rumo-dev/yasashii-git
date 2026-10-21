'use strict';
/**
 * Git 操作モジュール。
 * すべての関数は { ok:true, data, info } または { ok:false, error:{code,message,raw} } を返す。
 * エラーメッセージは初心者向けの日本語に変換される。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  LANGUAGE: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];
// ファイル名を渡す操作では、「*」や「?」を含む名前も文字どおり扱う（stash等の内部処理には付けない）
const LIT = ['--literal-pathspecs'];

// ---------------------------------------------------------------
// 低レベル実行
// ---------------------------------------------------------------
function run(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    if (cwd && !fs.existsSync(cwd)) {
      return resolve({ ok: false, code: 'ENOCWD', out: '', err: 'folder not found' });
    }
    let child;
    try {
      child = execFile(
        'git',
        [...(opts.literal ? LIT : []), ...BASE_ARGS, ...args],
        { cwd: cwd || undefined, env: ENV, maxBuffer: 200 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.code === 'ENOENT') {
            return resolve({ ok: false, code: 'ENOENT', out: '', err: 'git not found' });
          }
          resolve({ ok: !error, code: error ? error.code : 0, out: stdout || '', err: stderr || '' });
        }
      );
    } catch (e) {
      return resolve({ ok: false, code: 'ENOENT', out: '', err: String(e) });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input != null ? opts.input : '');
  });
}

// ---------------------------------------------------------------
// エラーの日本語化
// ---------------------------------------------------------------
const RULES = [
  [/Please tell me who you are|unable to auto-detect email address|empty ident name|Author identity unknown/i, 'NO_IDENTITY',
    '記録に残す「名前」と「メールアドレス」がまだ設定されていません。'],
  [/CONFLICT|Automatic merge failed|fix conflicts|could not apply|after resolving the conflicts/i, 'CONFLICT',
    '内容がぶつかりました（同じ場所を別々に変更したためです）。「変更」画面でぶつかったファイルをどちらの内容にするか選んでください。'],
  [/would be overwritten by (merge|checkout|cherry-pick|revert)|Your local changes to the following files would be overwritten|Please commit your changes or stash them/i, 'DIRTY',
    'まだ記録していない変更が上書きされてしまうため、実行できません。先に変更を記録するか、「一時避難」で脇に置いてください。'],
  [/non-fast-forward|\[rejected\]|fetch first|tip of your current branch is behind|Updates were rejected/i, 'REJECTED',
    'オンライン側に、あなたのパソコンにはまだない新しい記録があるため送れませんでした。先に「オンラインの最新を取り込む」を行ってください。'],
  [/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey\)|Invalid username or password|returned error: 40[13]|HTTP 40[13]|Support for password authentication was removed/i, 'AUTH',
    'ログインに失敗しました。GitHubの場合は、パスワードではなく「アクセストークン」が必要です。「設定」画面のヒントを確認してください。'],
  [/Could not resolve host|Failed to connect|Network is unreachable|Connection timed out|Connection refused|unable to access/i, 'NETWORK',
    'インターネットに接続できません。ネット接続とURLを確認してください。'],
  [/Repository not found|does not appear to be a git repository|repository '.*' not found/i, 'NOT_FOUND',
    'オンラインの保管場所が見つかりません。URLが正しいか、アクセス権があるかを確認してください。'],
  [/not a git repository/i, 'NOT_REPO', 'このフォルダはまだ履歴管理が始まっていません。'],
  [/nothing to commit|no changes added to commit|nothing added to commit/i, 'NOTHING', '記録する変更がありません。'],
  [/not fully merged/i, 'NOT_MERGED',
    'この作業ラインには、まだ他に取り込まれていない記録があります。削除すると失われます。'],
  [/already exists/i, 'EXISTS', '同じ名前のものがすでにあります。別の名前にしてください。'],
  [/not a valid (branch|ref)|is not a valid branch name|invalid reference|not a valid tag name/i, 'BAD_NAME',
    'この名前は使えません。スペースや「~ ^ : ? * [ \\」などは避けてください。'],
  [/There is no tracking information|no upstream branch|has no upstream/i, 'NO_UPSTREAM',
    'この作業ラインはまだオンラインと結びついていません。先に「オンラインに送る」を行ってください。'],
  [/refusing to merge unrelated histories/i, 'UNRELATED',
    '履歴のつながりがまったく別のものなので取り込めません。'],
  [/pathspec .* did not match|unknown revision|bad revision|not a commit|bad object/i, 'NOT_FOUND_REF',
    '指定されたものが見つかりませんでした。'],
  [/index\.lock/i, 'LOCKED',
    '別のGit操作が実行中か、前回の操作が途中で止まっています。他のGitアプリを閉じてから、もう一度試してください。'],
  [/CONFLICT \(modify\/delete\)/i, 'CONFLICT', '削除と変更がぶつかりました。'],
];

function friendly(r) {
  const raw = `${r.err || ''}\n${r.out || ''}`.trim();
  if (r.code === 'ENOENT') {
    return { code: 'NO_GIT', message: 'Git がパソコンにインストールされていません。https://git-scm.com/ からインストールしてください。', raw };
  }
  if (r.code === 'ENOCWD') {
    return { code: 'NO_FOLDER', message: 'フォルダが見つかりません。移動または削除された可能性があります。', raw };
  }
  for (const [re, code, message] of RULES) {
    if (re.test(raw)) return { code, message, raw };
  }
  return { code: 'UNKNOWN', message: 'うまくいきませんでした。', raw };
}

const ok = (data, r) => ({ ok: true, data: data === undefined ? null : data, info: r ? `${r.out}\n${r.err}`.trim() : '' });
const fail = (r) => ({ ok: false, error: friendly(r) });
const failMsg = (message, code = 'INVALID') => ({ ok: false, error: { code, message, raw: '' } });
const simple = async (cwd, args, opts) => {
  const r = await run(cwd, args, opts);
  return r.ok ? ok(null, r) : fail(r);
};
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------
// リポジトリの基本
// ---------------------------------------------------------------
async function gitVersion() {
  const r = await run(null, ['--version']);
  return r.ok ? ok(r.out.trim()) : fail(r);
}

async function isRepo(dir) {
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  if (!r.ok) {
    const f = friendly(r);
    return { ok: true, data: { repo: false, code: f.code, root: null } };
  }
  return ok({ repo: true, root: path.normalize(r.out.trim()) });
}

async function init(dir) {
  let r = await run(dir, ['init', '-b', 'main']);
  if (!r.ok) r = await run(dir, ['init']);
  return r.ok ? ok(null, r) : fail(r);
}

async function clone(_cwd, { url, dest }) {
  if (!url || !dest) return failMsg('URLと保存先を指定してください。');
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const r = await run(parent, ['clone', url, dest]);
  return r.ok ? ok({ path: dest }, r) : fail(r);
}

// ---------------------------------------------------------------
// 状態
// ---------------------------------------------------------------
async function status(cwd) {
  const r = await run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (!r.ok) return fail(r);
  const t = r.out.split('\0');
  const info = { branch: null, oid: null, hasCommits: true, upstream: null, ahead: 0, behind: 0, detached: false, files: [], operation: null };
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (!e) continue;
    if (e.startsWith('# branch.oid ')) {
      info.oid = e.slice(13);
      if (info.oid === '(initial)') info.hasCommits = false;
    } else if (e.startsWith('# branch.head ')) {
      const h = e.slice(14);
      if (h === '(detached)') info.detached = true;
      else info.branch = h;
    } else if (e.startsWith('# branch.upstream ')) {
      info.upstream = e.slice(18);
    } else if (e.startsWith('# branch.ab ')) {
      const m = e.match(/\+(\d+) -(\d+)/);
      if (m) { info.ahead = +m[1]; info.behind = +m[2]; }
    } else if (e[0] === '1') {
      const p = e.split(' ');
      info.files.push({ path: p.slice(8).join(' '), x: p[1][0], y: p[1][1], conflict: false, untracked: false });
    } else if (e[0] === '2') {
      const p = e.split(' ');
      const orig = t[++i];
      info.files.push({ path: p.slice(9).join(' '), orig, x: p[1][0], y: p[1][1], conflict: false, untracked: false });
    } else if (e[0] === 'u') {
      const p = e.split(' ');
      info.files.push({ path: p.slice(10).join(' '), x: p[1][0], y: p[1][1], conflict: true, untracked: false });
    } else if (e[0] === '?') {
      info.files.push({ path: e.slice(2), x: '?', y: '?', conflict: false, untracked: true });
    }
  }
  // 途中の操作（取り込み中など）を調べる
  const g = await run(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD']);
  if (g.ok) {
    const [m, c, v] = g.out.split('\n').map((s) => s.trim());
    const ex = (p) => p && fs.existsSync(path.resolve(cwd, p));
    if (ex(m)) info.operation = 'merge';
    else if (ex(c)) info.operation = 'cherry-pick';
    else if (ex(v)) info.operation = 'revert';
  }
  return ok(info);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const MAX_DIFF = 3 * 1024 * 1024;
function packDiff(text) {
  if (/^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text)) {
    // バイナリが混ざる場合も、テキスト部分は返す
  }
  let truncated = false;
  if (text.length > MAX_DIFF) {
    text = text.slice(0, text.lastIndexOf('\n', MAX_DIFF));
    truncated = true;
  }
  return { text, truncated };
}

async function diff(cwd, { path: p, staged, untracked }) {
  if (untracked) {
    const full = path.resolve(cwd, p);
    let st;
    try { st = fs.statSync(full); } catch { return ok({ text: '', missing: true }); }
    if (st.isDirectory()) return ok({ text: '', note: 'フォルダです。' });
    if (st.size > 1024 * 1024) return ok({ text: '', tooLarge: true });
    const buf = fs.readFileSync(full);
    if (looksBinary(buf)) return ok({ text: '', binary: true });
    const body = buf.toString('utf8');
    const ls = body.split('\n');
    if (ls[ls.length - 1] === '') ls.pop();
    const text =
      `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n` +
      (ls.length ? `@@ -0,0 +1,${ls.length} @@\n` + ls.map((l) => '+' + l).join('\n') + '\n' : '');
    return ok({ text, isNew: true });
  }
  const args = staged ? ['diff', '--cached', '--no-color', '-M', '--', p] : ['diff', '--no-color', '--', p];
  const r = await run(cwd, args, { literal: true });
  if (!r.ok) return fail(r);
  const d = packDiff(r.out);
  return ok({ ...d, binary: /^Binary files /m.test(r.out) && !/^@@ /m.test(r.out) });
}

// ---------------------------------------------------------------
// ステージ（記録に含める）・取り消し・記録
// ---------------------------------------------------------------
async function stage(cwd, paths) {
  if (!paths || !paths.length) return ok();
  return simple(cwd, ['add', '-A', '--', ...paths], { literal: true });
}
async function stageAll(cwd) {
  return simple(cwd, ['add', '-A']);
}
async function hasHead(cwd) {
  const r = await run(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.ok;
}
async function unstage(cwd, paths) {
  if (!paths || !paths.length) return ok();
  if (await hasHead(cwd)) return simple(cwd, ['reset', '-q', 'HEAD', '--', ...paths], { literal: true });
  return simple(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths], { literal: true });
}
async function unstageAll(cwd) {
  if (await hasHead(cwd)) return simple(cwd, ['reset', '-q']);
  return simple(cwd, ['rm', '--cached', '-r', '-q', '--', '.']);
}

/** 一部分（ハンクという塊）だけを記録に含める／外す */
async function applyPatch(cwd, { patch, reverse }) {
  const args = ['apply', '--cached', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : []), '-'];
  return simple(cwd, args, { input: patch });
}

/** 変更を取り消す。tracked: 記録済みファイルの変更, untracked: 新規ファイル（削除される） */
async function discard(cwd, { tracked = [], untracked = [] }) {
  if (tracked.length) {
    const r = await run(cwd, ['checkout', '--', ...tracked], { literal: true });
    if (!r.ok) return fail(r);
  }
  if (untracked.length) {
    const r = await run(cwd, ['clean', '-f', '-q', '--', ...untracked], { literal: true });
    if (!r.ok) return fail(r);
  }
  return ok();
}
async function discardAll(cwd) {
  if (await hasHead(cwd)) {
    const r = await run(cwd, ['reset', '--hard', '-q']);
    if (!r.ok) return fail(r);
  }
  const c = await run(cwd, ['clean', '-fd', '-q']);
  return c.ok ? ok() : fail(c);
}

async function commit(cwd, { summary, body, amend }) {
  const args = ['commit'];
  if (amend) args.push('--amend');
  args.push('-m', summary);
  if (body && body.trim()) args.push('-m', body.trim());
  return simple(cwd, args);
}
async function lastMessage(cwd) {
  const r = await run(cwd, ['log', '-1', '--format=%s%x1f%b']);
  if (!r.ok) return ok({ summary: '', body: '' });
  const [summary, body] = r.out.split('\x1f');
  return ok({ summary: (summary || '').trim(), body: (body || '').trim() });
}

// 取り込み・打ち消し等の途中操作
async function continueOperation(cwd, op) {
  if (op === 'merge') return simple(cwd, ['commit', '--no-edit']);
  if (op === 'cherry-pick') return simple(cwd, ['cherry-pick', '--continue']);
  if (op === 'revert') return simple(cwd, ['revert', '--continue']);
  return failMsg('続けられる操作がありません。');
}
async function abortOperation(cwd, op) {
  if (!['merge', 'cherry-pick', 'revert'].includes(op)) return failMsg('中止できる操作がありません。');
  return simple(cwd, [op, '--abort']);
}

/** ぶつかったファイルを解決。side: 'ours'(自分側) | 'theirs'(相手側) | 'mark'(今の内容で解決済みにする) */
async function resolveConflict(cwd, { path: p, side }) {
  if (side === 'ours' || side === 'theirs') {
    const r = await run(cwd, ['checkout', `--${side}`, '--', p], { literal: true });
    if (!r.ok) {
      // 片方で削除されていた場合
      const rm = await run(cwd, ['rm', '-q', '--', p], { literal: true });
      if (!rm.ok) return fail(r);
      return ok();
    }
  }
  return simple(cwd, ['add', '--', p], { literal: true });
}

async function ignore(cwd, pattern) {
  const file = path.join(cwd, '.gitignore');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* なければ新規 */ }
  const existing = cur.split(/\r?\n/);
  if (existing.includes(pattern)) return ok();
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, cur + sep + pattern + '\n');
  return ok();
}

// ---------------------------------------------------------------
// オンラインとのやり取り
// ---------------------------------------------------------------
async function fetchAll(cwd) {
  return simple(cwd, ['fetch', '--all', '--prune']);
}
async function pull(cwd) {
  const r = await run(cwd, ['pull', '--no-rebase', '--no-edit']);
  return r.ok ? ok(null, r) : fail(r);
}
async function push(cwd, { branch, remote, setUpstream, force } = {}) {
  let args;
  if (setUpstream) args = ['push', '-u', remote, branch];
  else args = ['push', ...(force ? ['--force-with-lease'] : [])];
  if (setUpstream && force) args.splice(1, 0, '--force-with-lease');
  return simple(cwd, args);
}

// ---------------------------------------------------------------
// 履歴
// ---------------------------------------------------------------
function parseRefs(d) {
  if (!d) return [];
  const out = [];
  for (const raw of d.split(', ')) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith('HEAD -> ')) out.push({ type: 'head', name: s.slice(8).replace(/^refs\/heads\//, '') });
    else if (s === 'HEAD') out.push({ type: 'detached', name: 'HEAD' });
    else if (s.startsWith('tag: ')) out.push({ type: 'tag', name: s.slice(5).replace(/^refs\/tags\//, '') });
    else if (s.startsWith('refs/remotes/')) {
      if (s.endsWith('/HEAD')) continue;
      out.push({ type: 'remote', name: s.slice(13) });
    } else if (s.startsWith('refs/heads/')) out.push({ type: 'branch', name: s.slice(11) });
    else if (s.startsWith('refs/stash')) continue;
    else out.push({ type: 'branch', name: s });
  }
  return out;
}

async function log(cwd, { limit = 300, all = true, search = '', branch = '' } = {}) {
  const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%D', '%s'].join('%x1f') + '%x1e';
  const args = ['log', '--date-order', '--decorate=full', `--max-count=${limit}`, `--format=${fmt}`];
  if (all) args.push('--all');
  if (search) args.push('-i', '--grep=' + search);
  if (branch) args.push(branch);
  const r = await run(cwd, args);
  if (!r.ok) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(r.err)) return ok([]);
    return fail(r);
  }
  const list = r.out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim());
  return ok(
    list.map((rec) => {
      const f = rec.split('\x1f');
      return {
        hash: f[0],
        short: f[0].slice(0, 7),
        parents: f[1] ? f[1].split(' ') : [],
        author: f[2],
        email: f[3],
        date: f[4],
        refs: parseRefs(f[5]),
        subject: f[6],
      };
    })
  );
}

async function commitBody(cwd, hash) {
  const r = await run(cwd, ['show', '-s', '--format=%B', hash]);
  return r.ok ? ok(r.out.trim()) : fail(r);
}

function parseNameStatus(out) {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length; ) {
    const st = t[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') {
      const old = t[i++];
      const p = t[i++];
      files.push({ status: st[0], path: p, old });
    } else {
      files.push({ status: st[0], path: t[i++] });
    }
  }
  return files;
}

async function commitFiles(cwd, hash) {
  const hasParent = (await run(cwd, ['rev-parse', '--verify', '-q', hash + '^'])).ok;
  const r = hasParent
    ? await run(cwd, ['diff', '--name-status', '-z', '-M', hash + '^', hash])
    : await run(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', hash]);
  return r.ok ? ok(parseNameStatus(r.out)) : fail(r);
}

async function commitDiff(cwd, { hash, path: p, old }) {
  const hasParent = (await run(cwd, ['rev-parse', '--verify', '-q', hash + '^'])).ok;
  const paths = old ? [old, p] : [p];
  const r = hasParent
    ? await run(cwd, ['diff', '--no-color', '-M', hash + '^', hash, '--', ...paths], { literal: true })
    : await run(cwd, ['show', '--format=', '--no-color', hash, '--', ...paths], { literal: true });
  if (!r.ok) return fail(r);
  return ok({ ...packDiff(r.out), binary: /^Binary files /m.test(r.out) && !/^@@ /m.test(r.out) });
}

// ---------------------------------------------------------------
// 作業ライン（ブランチ）
// ---------------------------------------------------------------
async function branches(cwd) {
  const fmt = ['%(refname)', '%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(subject)'].join('%1f');
  const r = await run(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes']);
  if (!r.ok) return fail(r);
  const local = [];
  const remote = [];
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const f = line.split('\x1f');
    if (f[0].startsWith('refs/heads/')) {
      const track = f[4] || '';
      const a = track.match(/ahead (\d+)/);
      const b = track.match(/behind (\d+)/);
      local.push({
        name: f[1], current: f[2] === '*', upstream: f[3] || null,
        ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: /gone/.test(track),
        hash: f[5], subject: f[6],
      });
    } else if (f[0].startsWith('refs/remotes/')) {
      if (f[0].endsWith('/HEAD')) continue;
      remote.push({ name: f[1], hash: f[5], subject: f[6] });
    }
  }
  return ok({ local, remote });
}

async function createBranch(cwd, { name, from, checkout }) {
  const args = checkout ? ['checkout', '-b', name] : ['branch', name];
  if (from) args.push(from);
  return simple(cwd, args);
}
/** 作業ラインを切り替える。remote:true のときは、オンラインのものをコピーして作業開始 */
async function checkout(cwd, { name, remote }) {
  return simple(cwd, remote ? ['checkout', '--track', name] : ['checkout', name]);
}
async function deleteBranch(cwd, { name, force }) {
  return simple(cwd, ['branch', force ? '-D' : '-d', name]);
}
async function renameBranch(cwd, { oldName, newName }) {
  return simple(cwd, ['branch', '-m', oldName, newName]);
}
async function deleteRemoteBranch(cwd, name) {
  const i = name.indexOf('/');
  if (i < 0) return failMsg('名前が正しくありません。');
  return simple(cwd, ['push', name.slice(0, i), '--delete', name.slice(i + 1)]);
}
/** mode: '' | 'noff' | 'squash' */
async function merge(cwd, { name, mode }) {
  const args = ['merge', '--no-edit'];
  if (mode === 'noff') args.push('--no-ff');
  if (mode === 'squash') args.push('--squash');
  args.push(name);
  return simple(cwd, args);
}

// ---------------------------------------------------------------
// 記録（コミット）に対する操作
// ---------------------------------------------------------------
async function reset(cwd, { hash, mode }) {
  if (!['soft', 'mixed', 'hard'].includes(mode)) return failMsg('方法が正しくありません。');
  return simple(cwd, ['reset', `--${mode}`, hash]);
}
async function revert(cwd, hash) {
  const p = await run(cwd, ['rev-list', '--parents', '-n', '1', hash]);
  const isMerge = p.ok && p.out.trim().split(' ').length > 2;
  return simple(cwd, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), hash]);
}
async function cherryPick(cwd, hash) {
  return simple(cwd, ['cherry-pick', hash]);
}

// ---------------------------------------------------------------
// 一時避難（スタッシュ）
// ---------------------------------------------------------------
async function stashList(cwd) {
  const r = await run(cwd, ['stash', 'list', '--format=%gd%x1f%gs%x1f%aI%x1e']);
  if (!r.ok) return fail(r);
  const items = r.out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim()).map((rec) => {
    const f = rec.split('\x1f');
    return { ref: f[0], message: (f[1] || '').replace(/^(WIP )?[Oo]n [^:]+: /, '').replace(/^[0-9a-f]{7,} /, ''), raw: f[1], date: f[2] };
  });
  return ok(items);
}
async function stashSave(cwd, { message, includeUntracked }) {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message) args.push('-m', message);
  return simple(cwd, args);
}
async function stashApply(cwd, ref) { return simple(cwd, ['stash', 'apply', ref]); }
async function stashPop(cwd, ref) { return simple(cwd, ['stash', 'pop', ref]); }
async function stashDrop(cwd, ref) { return simple(cwd, ['stash', 'drop', ref]); }
async function stashDiff(cwd, ref) {
  const r = await run(cwd, ['stash', 'show', '-p', '--no-color', ref]);
  return r.ok ? ok(packDiff(r.out)) : fail(r);
}

// ---------------------------------------------------------------
// 目印（タグ）
// ---------------------------------------------------------------
async function tags(cwd) {
  const fmt = ['%(refname:short)', '%(objectname:short)', '%(subject)', '%(creatordate:iso-strict)'].join('%1f');
  const r = await run(cwd, ['for-each-ref', '--sort=-creatordate', `--format=${fmt}`, 'refs/tags']);
  if (!r.ok) return fail(r);
  return ok(
    r.out.split('\n').filter(Boolean).map((l) => {
      const f = l.split('\x1f');
      return { name: f[0], hash: f[1], subject: f[2], date: f[3] };
    })
  );
}
async function createTag(cwd, { name, message, ref }) {
  const args = ['tag'];
  if (message) args.push('-a', name, '-m', message);
  else args.push(name);
  if (ref) args.push(ref);
  return simple(cwd, args);
}
async function deleteTag(cwd, name) { return simple(cwd, ['tag', '-d', name]); }
async function pushTag(cwd, { remote, name }) { return simple(cwd, ['push', remote, name]); }
async function deleteRemoteTag(cwd, { remote, name }) { return simple(cwd, ['push', remote, '--delete', name]); }

// ---------------------------------------------------------------
// オンラインの保管場所（リモート）
// ---------------------------------------------------------------
async function remotes(cwd) {
  const r = await run(cwd, ['remote', '-v']);
  if (!r.ok) return fail(r);
  const map = new Map();
  for (const l of lines(r.out)) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m && !map.has(m[1])) map.set(m[1], m[2]);
  }
  return ok([...map].map(([name, url]) => ({ name, url })));
}
async function addRemote(cwd, { name, url }) { return simple(cwd, ['remote', 'add', name, url]); }
async function removeRemote(cwd, name) { return simple(cwd, ['remote', 'remove', name]); }
async function setRemoteUrl(cwd, { name, url }) { return simple(cwd, ['remote', 'set-url', name, url]); }

/** 保管場所のURLから、ブラウザで開けるWebページのURLを求める */
async function webLinks(cwd) {
  const rs = await remotes(cwd);
  if (!rs.ok || !rs.data.length) return ok(null);
  const r = rs.data.find((x) => x.name === 'origin') || rs.data[0];
  let u = r.url.trim();
  let m;
  if ((m = u.match(/^git@([^:]+):(.+?)(?:\.git)?$/))) u = `https://${m[1]}/${m[2]}`;
  else if ((m = u.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/))) u = `https://${m[1]}/${m[2]}`;
  else if (/^https?:\/\//.test(u)) u = u.replace(/\.git$/, '').replace(/^http:/, 'https:').replace(/\/\/[^@/]+@/, '//');
  else return ok(null);
  const host = u.replace(/^https:\/\//, '').split('/')[0];
  return ok({ base: u, host, isGithub: host === 'github.com' });
}

// ---------------------------------------------------------------
// 設定（名前・メールアドレス）
// ---------------------------------------------------------------
async function getIdentity(cwd) {
  const base = cwd || os.homedir();
  const get = async (args) => {
    const r = await run(base, ['config', ...args]);
    return r.ok ? r.out.trim() : '';
  };
  return ok({
    name: await get(['--get', 'user.name']),
    email: await get(['--get', 'user.email']),
    globalName: await get(['--global', '--get', 'user.name']),
    globalEmail: await get(['--global', '--get', 'user.email']),
  });
}
async function setIdentity(cwd, { name, email, scope }) {
  const base = scope === 'local' && cwd ? cwd : os.homedir();
  const flag = scope === 'local' && cwd ? '--local' : '--global';
  let r = await run(base, ['config', flag, 'user.name', name]);
  if (!r.ok) return fail(r);
  r = await run(base, ['config', flag, 'user.email', email]);
  return r.ok ? ok() : fail(r);
}

module.exports = {
  gitVersion, isRepo, init, clone,
  status, diff,
  stage, stageAll, unstage, unstageAll, applyPatch, discard, discardAll,
  commit, lastMessage, continueOperation, abortOperation, resolveConflict, ignore,
  fetch: fetchAll, pull, push,
  log, commitBody, commitFiles, commitDiff,
  branches, createBranch, checkout, deleteBranch, renameBranch, deleteRemoteBranch, merge,
  reset, revert, cherryPick,
  stashList, stashSave, stashApply, stashPop, stashDrop, stashDiff,
  tags, createTag, deleteTag, pushTag, deleteRemoteTag,
  remotes, addRemote, removeRemote, setRemoteUrl, webLinks,
  getIdentity, setIdentity,
};
