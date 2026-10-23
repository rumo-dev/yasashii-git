'use strict';
/**
 * Git 操作層。すべての関数は先頭引数に「リポジトリのパス」を取る（clone / init を除く）。
 * エラーは日本語のやさしいメッセージ(message)と元のGitの出力(detail)を持つ GitError で返す。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const safety = require('./safety');
const { classifyAuth } = require('./auth-errors');

/* ------------------------------------------------------------------ */
/* エラー翻訳                                                          */
/* ------------------------------------------------------------------ */
class GitError extends Error {
  constructor(message, detail, code) {
    super(message);
    this.name = 'GitError';
    this.detail = detail || '';
    this.exitCode = code;
    this.kind = classifyAuth(detail); // 'auth'（ログイン切れ）/ 'ssh'（SSH鍵）/ ''。画面側が再ログインへ案内するのに使う
  }
}

const ERROR_RULES = [
  [/without [`'"]?workflow[`'"]? scope|workflow[`'"]? scope/i,
    'GitHubのログインに「ワークフロー（.github/workflows のファイル）を送る権限」が足りないため、拒否されました。ログインし直すと、必要な権限がつきます。'],
  [/Permission denied \(publickey|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key type|Load key .*: (invalid format|bad permissions)|Too many authentication failures/i,
    'SSH鍵でGitHubにつながりませんでした。「HTTPS形式に切り替える」と、いまログインしているGitHubアカウントだけで使えるようになります。'],
  [/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey\)|Invalid username or password|HTTP 401|requested URL returned error: 40[13]/i,
    'GitHubのログインが切れているか、認証に失敗しました。ログインし直してから、もう一度お試しください。'],
  [/non-fast-forward|fetch first|tip of your current branch is behind|Updates were rejected because/i,
    'サーバー側に、あなたの手元にはまだない更新があります。先に「最新を取り込む」を実行してから、もう一度アップロードしてください。'],
  [/Automatic merge failed|CONFLICT|could not apply|after resolving the conflicts/i,
    '同じ場所を別々に変更していたため、自動で合流できませんでした（ぶつかり）。「変更」画面で、どちらを採用するか選んでください。'],
  [/Please tell me who you are|empty ident name|unable to auto-detect email|Author identity unknown/i,
    '記録に残す「名前」と「メールアドレス」がまだ設定されていません。「設定」画面で入力してください。'],
  [/nothing to commit|no changes added to commit/i,
    '記録できる変更がありません。先に記録に含めるファイルを選んでください。'],
  [/not a git repository/i,
    'ここは Git で管理されているフォルダ（プロジェクト）ではありません。'],
  [/would be overwritten by (checkout|merge|switch)|Your local changes to the following files would be overwritten|commit your changes or stash them/i,
    'まだ記録していない変更が上書きされてしまうため、実行できません。先に「変更を記録」するか「一時退避」してください。'],
  [/already exists/i,
    '同じ名前のものがすでにあります。別の名前にしてください。'],
  [/not fully merged/i,
    'この作業の分岐には、まだ他へ合流していない作業が含まれています。消すと内容が失われます。'],
  [/Could not resolve host|unable to access|Failed to connect|Connection timed out|Network is unreachable|early EOF|RPC failed/i,
    'ネットワークにつながりませんでした。インターネット接続を確認してください。'],
  [/Repository not found|repository .* not found|does not appear to be a git repository|not found\b.*repository/i,
    '指定されたリポジトリが見つかりません。URLの間違い、または閲覧権限がない可能性があります。'],
  [/has no upstream branch|no upstream configured|There is no tracking information/i,
    'この作業の分岐は、まだアップロード先と結びついていません。'],
  [/No configured push destination|No remote repository specified|'origin' does not appear|No such remote/i,
    'アップロード先（接続先）がまだありません。'],
  [/refusing to merge unrelated histories/i,
    '履歴のつながりがまったく別のため、そのままでは合流できません。'],
  [/is not a valid branch name|not a valid ref|invalid reference|unknown revision|bad revision|not a commit/i,
    '指定された名前または記録が見つかりません。'],
  [/pathspec .* did not match/i,
    '指定されたファイルが見つかりません。'],
  [/index\.lock|Unable to create .*\.lock/i,
    '別のGit操作が動いているようです。しばらく待ってからやり直してください。（動いていない場合は、.git フォルダ内の index.lock を削除してください）'],
  [/destination path .* already exists and is not an empty directory/i,
    '保存先のフォルダがすでに存在し、空ではありません。別の場所を選んでください。'],
  [/Cannot delete branch .* checked out|cannot delete branch/i,
    '今作業中の分岐は削除できません。別の分岐に切り替えてからやり直してください。'],
  [/cannot rebase|You have unstaged changes|unmerged files|Committing is not possible because you have unmerged files/i,
    'ぶつかりが解決されていないファイルがあります。先に解決してください。'],
  [/patch does not apply|does not apply/i,
    'その部分は、すでに変更されているため適用できませんでした。画面を更新してやり直してください。'],
];

function friendly(stderr) {
  const s = String(stderr || '');
  for (const [re, msg] of ERROR_RULES) if (re.test(s)) return msg;
  // サーバーが送信を拒否したとき（権限・保護された分岐・サイズ制限など）：サーバーが書いた理由をそのまま添える
  const rej = s.match(/\[remote rejected\][^\n(]*\(([^)\n]+)\)/i);
  if (rej) return `サーバーに送信を拒否されました。（理由：${rej[1].trim()}）\n書き込みの権限や、保護された分岐でないかを確認してください。`;
  return '予期しないエラーが発生しました。「くわしい内容」を確認してください。';
}

/* ------------------------------------------------------------------ */
/* 実行基盤                                                            */
/* ------------------------------------------------------------------ */
const queues = new Map(); // repo -> Promise（同じリポジトリへの操作は順番に実行）

function baseEnv() {
  const env = { ...process.env };
  delete env.LC_ALL;
  env.LC_MESSAGES = 'C';
  env.LANGUAGE = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  env.GIT_MERGE_AUTOEDIT = 'no';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/**
 * git の進捗表示（stderr）を読み取る。
 * 例: "Writing objects:  45% (9/20), 1.20 MiB | 600.00 KiB/s" → 全体の進み具合(0-100)・今の作業名・速度
 * 全体は「数える 0-10%」「圧縮 10-30%」「送信 30-95%」「サーバー側の仕上げ 95-100%」で配分する。
 */
const PHASES = [
  [/Enumerating objects|Counting objects/i, 'ファイルを調べています', 0, 10],
  [/Compressing objects/i, 'ファイルを圧縮しています', 10, 30],
  [/Writing objects/i, 'サーバーへ送っています', 30, 95],
  [/Resolving deltas/i, 'サーバー側で仕上げています', 95, 100],
];
function parseProgress(line) {
  const l = String(line || '').replace(/^remote:\s*/, '').trim();
  if (!l) return null;
  for (const [re, label, from, to] of PHASES) {
    if (!re.test(l)) continue;
    const m = l.match(/(\d+)%\s*\((\d+)\/(\d+)\)/);
    const pct = m ? Number(m[1]) : (/done\.?$/i.test(l) ? 100 : 0);
    const rate = l.match(/\|\s*([\d.]+\s*\S*B\/s)/);
    const size = l.match(/,\s*([\d.]+\s*\S*B)\s*(?:\||,|$)/);
    return { label, percent: Math.round(from + (to - from) * pct / 100), phasePercent: pct,
      done: m ? Number(m[2]) : null, total: m ? Number(m[3]) : null, rate: rate ? rate[1] : '', size: size ? size[1] : '' };
  }
  return null;
}

function rawRun(args, { cwd, input, okCodes = [0], optionalLocks = true, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const full = [];
    if (!optionalLocks) full.push('--no-optional-locks');
    full.push('-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args);
    let child;
    try {
      child = spawn('git', full, { cwd, env: baseEnv(), windowsHide: true });
    } catch (e) {
      return reject(new GitError('Git が見つかりません。Git をインストールしてください。', String(e)));
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    let pbuf = '';
    child.stderr.on('data', (d) => {
      err.push(d);
      if (!onProgress) return;
      pbuf += d.toString('utf8');
      const parts = pbuf.split(/[\r\n]/); pbuf = parts.pop();
      for (const line of parts) { const pr = parseProgress(line); if (pr) { try { onProgress(pr); } catch (_) { /* 無視 */ } } }
    });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') reject(new GitError('Git が見つかりません。Git をインストールしてから、アプリを再起動してください。', String(e)));
      else reject(new GitError('Git を実行できませんでした。', String(e)));
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (okCodes.includes(code)) return resolve({ stdout, stderr, code });
      reject(new GitError(friendly(stderr + '\n' + stdout), (stderr + '\n' + stdout).trim(), code));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function run(args, opts = {}) {
  const key = opts.cwd || '';
  const prev = queues.get(key) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => rawRun(args, opts));
  queues.set(key, p);
  p.finally(() => { if (queues.get(key) === p) queues.delete(key); }).catch(() => {});
  return p;
}

const out = async (repo, args, opts = {}) => (await run(args, { cwd: repo, ...opts })).stdout;

function insideRepo(repo, p) {
  const abs = path.resolve(repo, p);
  const rel = path.relative(repo, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new GitError('リポジトリの外のファイルは操作できません。', p);
  return abs;
}

async function hasCommits(repo) {
  const r = await run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo, okCodes: [0, 1] });
  return r.code === 0;
}

/* ------------------------------------------------------------------ */
/* リポジトリ                                                          */
/* ------------------------------------------------------------------ */
async function checkRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return { isRepo: false, exists: false };
  const r = await run(['rev-parse', '--show-toplevel'], { cwd: dir, okCodes: [0, 128] });
  if (r.code !== 0) return { isRepo: false, exists: true };
  return { isRepo: true, exists: true, root: path.normalize(r.stdout.trim()) };
}

async function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await run(['init'], { cwd: dir });
  // 最初の分岐の名前を main にそろえる（古いGitでも動くように）
  await run(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir, okCodes: [0, 1] });
  return { root: dir };
}

function repoNameFromUrl(url) {
  const m = String(url).trim().replace(/\/+$/, '').match(/([^/:]+?)(?:\.git)?$/);
  return m ? m[1] : 'project';
}

async function clone(_unused, url, parentDir, folderName) {
  if (!url || !parentDir) throw new GitError('URLと保存先を入力してください。', '');
  const name = (folderName || repoNameFromUrl(url)).trim();
  const dest = path.join(parentDir, name);
  await run(['clone', url.trim(), dest], { cwd: parentDir });
  return { root: dest };
}

async function info(repo) {
  const top = (await out(repo, ['rev-parse', '--show-toplevel'])).trim();
  return { root: path.normalize(top), name: path.basename(top) };
}

/* ------------------------------------------------------------------ */
/* 状態（変更されたファイル）                                           */
/* ------------------------------------------------------------------ */
const STATE_LABEL = { M: '変更', A: '追加', D: '削除', R: '名前変更', C: 'コピー', T: '種類変更', '?': '新規', U: 'ぶつかり' };

function gitDirOf(repo) {
  return run(['rev-parse', '--git-dir'], { cwd: repo }).then((r) => {
    const d = r.stdout.trim();
    return path.isAbsolute(d) ? d : path.join(repo, d);
  });
}

async function status(repo) {
  const raw = await out(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], { optionalLocks: false });
  const tokens = raw.split('\0');
  const res = { branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, files: [], operation: null, hasCommits: true };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') { res.branch = val === '(detached)' ? null : val; res.detached = val === '(detached)'; }
      else if (key === 'branch.oid') { res.oid = val; if (val === '(initial)') res.hasCommits = false; }
      else if (key === 'branch.upstream') res.upstream = val;
      else if (key === 'branch.ab') { const m = val.match(/\+(\d+) -(\d+)/); if (m) { res.ahead = +m[1]; res.behind = +m[2]; } }
      continue;
    }
    const kind = t[0];
    if (kind === '1') {
      const p = t.split(' ');
      const xy = p[1];
      const file = p.slice(8).join(' ');
      res.files.push(mkFile(file, xy));
    } else if (kind === '2') {
      const p = t.split(' ');
      const xy = p[1];
      const file = p.slice(9).join(' ');
      const orig = tokens[++i];
      const f = mkFile(file, xy);
      f.orig = orig;
      res.files.push(f);
    } else if (kind === 'u') {
      const p = t.split(' ');
      const file = p.slice(10).join(' ');
      res.files.push({ path: file, orig: null, x: 'U', y: 'U', staged: false, unstaged: false, conflict: true, untracked: false, indexLabel: '', workLabel: STATE_LABEL.U });
    } else if (kind === '?') {
      res.files.push({ path: t.slice(2), orig: null, x: '.', y: '?', staged: false, unstaged: true, conflict: false, untracked: true, indexLabel: '', workLabel: STATE_LABEL['?'] });
    }
  }
  // 追跡先がまだない作業ブランチ（タスクから作ったブランチなど）は、
  // porcelain status に branch.ab が出ない。どのリモート追跡ブランチにも
  // 含まれていない記録数を数え、アップロードボタンを正しく有効にする。
  if (res.hasCommits && !res.upstream) {
    try {
      const count = await out(repo, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      res.ahead = Number.parseInt(count.trim(), 10) || 0;
    } catch (_) { /* 数えられなくてもファイルの状態は表示する */ }
  }
  try { await annotateBig(repo, res.files); } catch (_) { /* サイズ判定に失敗しても、一覧は表示する */ }
  try {
    const gd = await gitDirOf(repo);
    if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) res.operation = 'merge';
    else if (fs.existsSync(path.join(gd, 'REVERT_HEAD'))) res.operation = 'revert';
    else if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) res.operation = 'cherry-pick';
    else if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) res.operation = 'rebase';
  } catch (_) { /* 無視 */ }
  return res;
}

/* ---------------- 100MBを超えるファイル（GitHubが受け付けない）と Git LFS ---------------- */
const BIG_LIMIT = 100 * 1024 * 1024;
/** 作業フォルダ側が 100MB を超えるファイルに印を付ける。size=大きさ / lfs=Git LFSで管理する設定済み / tooBig=記録に含められない */
async function annotateBig(repo, files) {
  const big = [];
  for (const f of files) {
    if (!f.unstaged || f.conflict || f.y === 'D') continue;
    try { const st = fs.statSync(path.join(repo, f.path)); if (st.isFile() && st.size > BIG_LIMIT) { f.size = st.size; big.push(f); } } catch (_) { /* 無視 */ }
  }
  if (!big.length) return;
  const lfs = new Set();
  try {
    const r = await run(['check-attr', '-z', 'filter', '--stdin'], { cwd: repo, input: big.map((f) => f.path).join('\0'), okCodes: [0, 1, 128], optionalLocks: false });
    const t = r.stdout.split('\0');
    for (let i = 0; i + 2 < t.length; i += 3) if (t[i + 2] === 'lfs') lfs.add(t[i]);
  } catch (_) { /* 無視 */ }
  for (const f of big) { f.lfs = lfs.has(f.path); f.tooBig = !f.lfs; }
}
const tooBigPaths = async (repo) => (await status(repo)).files.filter((f) => f.tooBig).map((f) => f.path);
const BIG_MSG = '100MBを超えるファイルは、そのままではGitHubに送れないため記録に含められません。「Git LFSで管理する」か「管理しない」を選んでください。';

async function lfsInfo(repo) {
  const r = await run(['lfs', 'version'], { cwd: repo, okCodes: [0, 1, 2, 127, 128] }).catch(() => ({ code: 1, stdout: '' }));
  return { available: r.code === 0, version: r.code === 0 ? r.stdout.trim() : '' };
}
/** ファイルを Git LFS の管理にして、記録に含める（.gitattributes も一緒に） */
async function lfsTrack(repo, file) {
  insideRepo(repo, file);
  if (!(await lfsInfo(repo)).available) throw new GitError('Git LFS がこのパソコンにインストールされていません。https://git-lfs.com/ からインストールしてから、もう一度お試しください。', '');
  await run(['lfs', 'install', '--local'], { cwd: repo });
  await run(['lfs', 'track', '--', file], { cwd: repo });
  await run(['add', '--', '.gitattributes'], { cwd: repo });
  await run(['add', '-A', '--', file], { cwd: repo });
  return true;
}

function mkFile(file, xy) {
  const x = xy[0];
  const y = xy[1];
  return {
    path: file, orig: null, x, y,
    staged: x !== '.', unstaged: y !== '.',
    conflict: false, untracked: false,
    indexLabel: STATE_LABEL[x] || '', workLabel: STATE_LABEL[y] || '',
  };
}

const MAX_DIFF = 400 * 1024;
function clip(text) {
  if (text.length > MAX_DIFF) return text.slice(0, MAX_DIFF) + '\n\n…（大きすぎるため、ここから先は表示を省略しました）';
  return text;
}

async function diff(repo, { path: file, staged = false, untracked = false, context = 3 } = {}) {
  if (untracked) {
    const abs = insideRepo(repo, file);
    const r = await run(['diff', '--no-index', '--no-color', `-U${context}`, '--', os_null(), abs], { cwd: repo, okCodes: [0, 1] });
    // 出力中の絶対パスを相対パスへ
    const rel = file.replace(/\\/g, '/');
    return clip(r.stdout.split(abs.replace(/\\/g, '/')).join(rel).split(abs).join(rel));
  }
  const args = ['diff', '--no-color', `-U${context}`];
  if (staged) args.push('--cached');
  args.push('--', file);
  return clip(await out(repo, args));
}
function os_null() { return process.platform === 'win32' ? 'NUL' : '/dev/null'; }

async function applyPatch(repo, patch, { cached = true, reverse = false } = {}) {
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (cached) args.push('--cached');
  if (reverse) args.push('--reverse');
  args.push('-');
  await run(args, { cwd: repo, input: patch });
  return true;
}

/* ------------------------------------------------------------------ */
/* 記録に含める / 外す / 破棄                                           */
/* ------------------------------------------------------------------ */
async function stage(repo, paths) {
  if (!paths || !paths.length) return true;
  const blocked = new Set(await tooBigPaths(repo));
  const ok = paths.filter((p) => !blocked.has(p));
  if (!ok.length) throw new GitError(BIG_MSG, paths.join('\n'));
  await run(['add', '-A', '--', ...ok], { cwd: repo });
  return { skipped: paths.length - ok.length };
}
/** 100MBを超えるファイル以外をすべて記録に含める。含めなかった数を返す */
async function stageAll(repo) {
  const blocked = await tooBigPaths(repo);
  const args = ['add', '-A', '--', '.', ...blocked.map((p) => `:(exclude,literal)${p}`)];
  await run(args, { cwd: repo });
  return { skipped: blocked.length };
}

async function unstage(repo, paths) {
  if (!paths || !paths.length) return true;
  if (await hasCommits(repo)) await run(['restore', '--staged', '--', ...paths], { cwd: repo });
  else await run(['rm', '--cached', '-r', '-q', '--', ...paths], { cwd: repo });
  return true;
}
async function unstageAll(repo) {
  if (await hasCommits(repo)) await run(['reset', '-q'], { cwd: repo });
  else await run(['rm', '--cached', '-r', '-q', '.'], { cwd: repo, okCodes: [0, 128] });
  return true;
}

/** files: [{path, untracked, staged}] */
async function discard(repo, files) {
  const commits = await hasCommits(repo);
  for (const f of files) {
    const abs = insideRepo(repo, f.path);
    if (f.untracked) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else if (f.worktreeOnly) {
      // 「記録に含める」済みの変更は残し、その後の変更だけを捨てる
      await run(['restore', '--worktree', '--', f.path], { cwd: repo });
    } else if (commits) {
      await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path], { cwd: repo });
    } else {
      await run(['rm', '-f', '-q', '--', f.path], { cwd: repo });
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 記録（コミット）                                                     */
/* ------------------------------------------------------------------ */
async function commit(repo, { summary, body = '', amend = false } = {}) {
  const s = (summary || '').trim();
  if (!s && !amend) throw new GitError('「記録のメモ」を入力してください。', '');
  const args = ['commit'];
  if (amend) args.push('--amend');
  if (s) { args.push('-m', s); if (body.trim()) args.push('-m', body.trim()); }
  else args.push('--no-edit');
  await run(args, { cwd: repo });
  return true;
}

async function undoLastCommit(repo) {
  const r = await run(['rev-parse', '--verify', '-q', 'HEAD~1'], { cwd: repo, okCodes: [0, 1] });
  if (r.code === 0) await run(['reset', '--soft', 'HEAD~1'], { cwd: repo });
  else await run(['update-ref', '-d', 'HEAD'], { cwd: repo });
  return true;
}

async function lastCommitMessage(repo) {
  if (!(await hasCommits(repo))) return { summary: '', body: '' };
  const s = (await out(repo, ['log', '-1', '--format=%s'])).replace(/\n$/, '');
  const b = (await out(repo, ['log', '-1', '--format=%b'])).trim();
  return { summary: s, body: b };
}

/* ------------------------------------------------------------------ */
/* 履歴                                                                */
/* ------------------------------------------------------------------ */
const FS = '\x1f';
const RS = '\x1e';

function parseRefs(d) {
  const refs = [];
  if (!d) return refs;
  for (const part of d.split(', ')) {
    const p = part.trim();
    if (!p) continue;
    if (p.startsWith('HEAD -> ')) { refs.push({ type: 'head', name: p.slice(8), current: true }); }
    else if (p === 'HEAD') refs.push({ type: 'detached', name: 'HEAD', current: true });
    else if (p.startsWith('tag: ')) refs.push({ type: 'tag', name: p.slice(5) });
    else if (p.includes('/')) refs.push({ type: 'remote', name: p });
    else refs.push({ type: 'branch', name: p });
  }
  return refs;
}

async function log(repo, { limit = 200, skip = 0, all = true, search = '', branch = null, file = null } = {}) {
  if (!(await hasCommits(repo))) return [];
  const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%D', '%s', '%b'].join(FS) + RS;
  const args = ['log', `--format=${fmt}`, '--date-order', `-n${limit}`, `--skip=${skip}`];
  if (search) args.push('-i', `--grep=${search}`, '--regexp-ignore-case');
  if (branch) args.push(branch); else if (all) args.push('--all');
  if (file) args.push('--follow', '--', file);
  const raw = await out(repo, args);
  return raw.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [hash, parents, name, email, date, refs, subject, body] = rec.split(FS);
    return {
      hash, short: hash.slice(0, 7), parents: parents ? parents.split(' ') : [],
      author: name, email, date, refs: parseRefs(refs), subject, body: (body || '').trim(),
    };
  });
}

async function commitFiles(repo, hash) {
  const raw = await out(repo, ['show', '--format=', '--name-status', '-M', '--first-parent', '-z', hash]);
  const t = raw.split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const st = t[i][0];
    if (st === 'R' || st === 'C') { files.push({ status: st, label: STATE_LABEL[st], orig: t[i + 1], path: t[i + 2] }); i += 2; }
    else { files.push({ status: st, label: STATE_LABEL[st] || st, path: t[i + 1] }); i += 1; }
  }
  return files;
}

async function commitDiff(repo, hash, file) {
  const args = ['show', '--format=', '--no-color', '-M', '--first-parent', hash];
  if (file) args.push('--', file);
  return clip(await out(repo, args));
}

async function revertCommit(repo, hash) {
  const parents = (await out(repo, ['rev-list', '--parents', '-n1', hash])).trim().split(' ').length - 1;
  const args = ['revert', '--no-edit'];
  if (parents > 1) args.push('-m', '1');
  args.push(hash);
  const r = await run(args, { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false };
}

async function cherryPick(repo, hash) {
  const r = await run(['cherry-pick', hash], { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false };
}

/** mode: 'keep'（変更は残す）| 'staged'（記録候補として残す）| 'discard'（変更も消す） */
async function resetTo(repo, hash, mode = 'keep') {
  const flag = mode === 'discard' ? '--hard' : mode === 'staged' ? '--soft' : '--mixed';
  await run(['reset', flag, hash], { cwd: repo });
  return true;
}

async function conflictOrThrow(repo, r) {
  const st = await status(repo);
  if (st.files.some((f) => f.conflict)) return { conflict: true };
  throw new GitError(friendly(r.stderr + r.stdout), (r.stderr + '\n' + r.stdout).trim(), r.code);
}

/* ------------------------------------------------------------------ */
/* ブランチ（作業の分岐）                                                 */
/* ------------------------------------------------------------------ */
async function branches(repo) {
  const fmt = ['%(refname)', '%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(subject)', '%(committerdate:iso-strict)'].join(FS);
  const raw = await out(repo, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  const local = [];
  const remote = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, short, head, upstream, track, sha, subject, date] = line.split(FS);
    if (ref.endsWith('/HEAD')) continue;
    const b = { name: short, current: head === '*', upstream: upstream || null, track: track || '', sha, subject, date };
    const am = (track || '').match(/ahead (\d+)/); const bm = (track || '').match(/behind (\d+)/);
    b.ahead = am ? +am[1] : 0; b.behind = bm ? +bm[1] : 0; b.gone = /gone/.test(track || '');
    if (ref.startsWith('refs/heads/')) local.push(b); else remote.push(b);
  }
  return { local, remote };
}

async function validateBranchName(repo, name) {
  const r = await run(['check-ref-format', '--branch', name], { cwd: repo, okCodes: [0, 1, 128] });
  if (r.code !== 0) throw new GitError('その名前は使えません。空白や ~ ^ : ? * [ \\ などの記号は使えません。', name);
}

async function createBranch(repo, name, { from = null, switchTo = true } = {}) {
  name = (name || '').trim();
  if (!name) throw new GitError('名前を入力してください。', '');
  await validateBranchName(repo, name);
  if (switchTo) await run(['switch', '-c', name, ...(from ? [from] : [])], { cwd: repo });
  else await run(['branch', name, ...(from ? [from] : [])], { cwd: repo });
  return true;
}

/** GitFlowの基本分岐（本番用と開発用）を用意し、よく使われる接頭辞をローカル設定に保存 */
async function initializeGitFlow(repo, { productionBranch, developmentBranch = 'develop' } = {}) {
  const st = await status(repo);
  if (!st.hasCommits) throw new GitError('GitFlowを始めるには、まず最初の変更を記録してください。', 'no commits');
  if (st.detached) throw new GitError('過去の記録を見ている状態では初期化できません。「作業の分岐」から分岐に切り替えてください。', 'detached HEAD');
  if (st.operation) throw new GitError('進行中の合流などを完了または中止してから、もう一度お試しください。', st.operation);
  if (st.files.length) throw new GitError('作業中の変更があります。先に「一時退避」へ保存してから初期化してください。', 'working tree is not clean');

  productionBranch = (productionBranch || '').trim();
  developmentBranch = (developmentBranch || '').trim();
  if (!productionBranch || !developmentBranch) throw new GitError('本番用と開発用の分岐を選んでください。', 'missing branch name');
  await validateBranchName(repo, developmentBranch);
  if (productionBranch === developmentBranch) throw new GitError('本番用と開発用には別々の分岐名を指定してください。', 'same branch name');

  const current = await branches(repo);
  if (!current.local.some((b) => b.name === productionBranch)) throw new GitError(`本番用の分岐「${productionBranch}」が見つかりません。`, productionBranch);
  const exists = current.local.some((b) => b.name === developmentBranch);
  const remoteMatches = current.remote.filter((b) => b.name.slice(b.name.indexOf('/') + 1) === developmentBranch);
  if (!exists && remoteMatches.length) {
    const remote = remoteMatches.find((b) => b.name.startsWith('origin/')) || remoteMatches[0];
    await switchBranch(repo, remote.name, { remote: true });
  } else {
    if (!exists) await createBranch(repo, developmentBranch, { from: productionBranch, switchTo: false });
    await switchBranch(repo, developmentBranch);
  }

  // git-flow-avh と互換性のあるローカル設定。既存の分岐名は変更しない。
  const config = [
    ['gitflow.branch.master', productionBranch],
    ['gitflow.branch.develop', developmentBranch],
    ['gitflow.prefix.feature', 'feature/'],
    ['gitflow.prefix.release', 'release/'],
    ['gitflow.prefix.hotfix', 'hotfix/'],
    ['gitflow.prefix.support', 'support/'],
    ['gitflow.prefix.versiontag', 'v'],
  ];
  for (const [key, value] of config) await run(['config', '--local', key, value], { cwd: repo });
  return { productionBranch, developmentBranch, created: !exists && !remoteMatches.length, trackedRemote: !exists && remoteMatches.length > 0 };
}

async function gitFlowConfig(repo) {
  const read = async (key) => {
    const r = await run(['config', '--local', '--get', key], { cwd: repo, okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const productionBranch = await read('gitflow.branch.master');
  const developmentBranch = await read('gitflow.branch.develop');
  if (!productionBranch || !developmentBranch) return null;
  return {
    productionBranch, developmentBranch,
    prefixes: {
      feature: await read('gitflow.prefix.feature') || 'feature/',
      release: await read('gitflow.prefix.release') || 'release/',
      hotfix: await read('gitflow.prefix.hotfix') || 'hotfix/',
      support: await read('gitflow.prefix.support') || 'support/',
      versiontag: await read('gitflow.prefix.versiontag'),
    },
  };
}

async function beginGitFlowBranch(repo, { type, name, issueNumber } = {}) {
  const config = await gitFlowConfig(repo);
  if (!config) throw new GitError('先に「GitFlowを初期化」してください。', 'GitFlow is not initialized');
  const st = await status(repo);
  if (!st.hasCommits) throw new GitError('最初の変更を記録してから、GitFlowの分岐を作ってください。', 'no commits');
  if (st.detached || st.operation) throw new GitError('過去の記録を見ている状態や、合流中には作成できません。分岐に戻るか、進行中の操作を完了してください。', st.operation || 'detached HEAD');
  if (st.files.length) throw new GitError('作業中の変更があります。先に「一時退避」へ保存してください。', 'working tree is not clean');
  if (!['feature', 'release', 'hotfix'].includes(type)) throw new GitError('feature、release、hotfixのいずれかを選んでください。', String(type));
  const prefix = config.prefixes[type];
  const rawName = (name || '').trim();
  if (!rawName) throw new GitError('分岐の名前を入力してください。', 'missing branch name');
  const branch = rawName.startsWith(prefix) ? rawName : prefix + rawName;
  await validateBranchName(repo, branch);
  const base = type === 'hotfix' ? config.productionBranch : config.developmentBranch;
  const current = await branches(repo);
  if (!current.local.some((b) => b.name === base)) throw new GitError(`開始元の分岐「${base}」が見つかりません。GitFlow設定を確認してください。`, base);
  if (current.local.some((b) => b.name === branch) || current.remote.some((b) => b.name.slice(b.name.indexOf('/') + 1) === branch)) {
    throw new GitError(`分岐「${branch}」はすでにあります。別の名前を使ってください。`, branch);
  }
  await createBranch(repo, branch, { from: base, switchTo: true });
  if (issueNumber != null) await bindTaskBranch(repo, issueNumber, branch);
  return { branch, base, type };
}

async function readTaskBranchMap(repo) {
  const r = await run(['config', '--local', '--get', 'yasashiigit.task-branches'], { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0 || !r.stdout.trim()) return {};
  try { return JSON.parse(r.stdout.trim()); } catch (_) { return {}; }
}

async function writeTaskBranchMap(repo, map) {
  const key = 'yasashiigit.task-branches';
  if (Object.keys(map).length) await run(['config', '--local', '--replace-all', key, JSON.stringify(map)], { cwd: repo });
  else await run(['config', '--local', '--unset-all', key], { cwd: repo, okCodes: [0, 1] });
}

async function bindTaskBranch(repo, issueNumber, branch) {
  const key = String(issueNumber);
  if (!/^\d+$/.test(key)) throw new GitError('課題番号を確認できません。', key);
  const map = await readTaskBranchMap(repo);
  map[key] = branch;
  await writeTaskBranchMap(repo, map);
  return branch;
}

async function getTaskBranch(repo, issueNumber) {
  const branch = (await readTaskBranchMap(repo))[String(issueNumber)];
  if (!branch) return null;
  const current = await branches(repo);
  return current.local.some((b) => b.name === branch) ? branch : null;
}

async function removeTaskBranchBinding(repo, branch) {
  const map = await readTaskBranchMap(repo);
  let changed = false;
  for (const [issue, name] of Object.entries(map)) if (name === branch) { delete map[issue]; changed = true; }
  if (changed) await writeTaskBranchMap(repo, map);
}

async function createTaskBranch(repo, { issueNumber, name } = {}) {
  const st = await status(repo);
  if (!st.hasCommits) throw new GitError('最初の変更を記録してから、タスクの分岐を作ってください。', 'no commits');
  if (st.detached || st.operation) throw new GitError('過去の記録を見ている状態や、合流中にはタスクの分岐を作れません。', st.operation || 'detached HEAD');
  if (st.files.length) throw new GitError('作業中の変更があります。先に「一時退避」へ保存してください。', 'working tree is not clean');
  name = (name || '').trim();
  await validateBranchName(repo, name);
  const current = await branches(repo);
  if (current.local.some((b) => b.name === name)) await switchBranch(repo, name);
  else await createBranch(repo, name, { switchTo: true });
  if (issueNumber != null) await bindTaskBranch(repo, issueNumber, name);
  return { branch: name };
}

async function finishGitFlowBranch(repo, { branch, tagName } = {}) {
  const config = await gitFlowConfig(repo);
  if (!config) throw new GitError('先に「GitFlowを初期化」してください。', 'GitFlow is not initialized');
  const st = await status(repo);
  if (st.operation) throw new GitError('進行中の合流などを完了または中止してから、作業の分岐を完了してください。', st.operation);
  if (st.files.length) throw new GitError('作業中の変更があります。先に記録するか、名前を付けて一時退避してください。', 'working tree is not clean');
  branch = (branch || st.branch || '').trim();
  if (!branch) throw new GitError('完了する作業の分岐を選んでください。', 'missing branch');
  const local = await branches(repo);
  if (!local.local.some((b) => b.name === branch)) throw new GitError(`手元に分岐「${branch}」が見つかりません。`, branch);
  const kind = ['feature', 'release', 'hotfix'].find((type) => branch.startsWith(config.prefixes[type]));
  if (!kind || branch.length <= config.prefixes[kind].length) throw new GitError('GitFlowのfeature、release、hotfix分岐ではありません。', branch);
  const targets = kind === 'feature' ? [config.developmentBranch] : [config.productionBranch, config.developmentBranch];
  if (targets.includes(branch)) throw new GitError('本番用・開発用の基本分岐はここから完了できません。', branch);
  for (const target of targets) if (!local.local.some((b) => b.name === target)) throw new GitError(`取り込み先の分岐「${target}」が見つかりません。`, target);

  let tag = null;
  if (kind !== 'feature') {
    const prefix = config.prefixes.versiontag;
    const value = (tagName || '').trim();
    if (!value) throw new GitError(`${kind === 'release' ? 'release' : 'hotfix'}の完了にはバージョンの目印が必要です。`, 'missing version tag');
    tag = value.startsWith(prefix) ? value : prefix + value;
    const refCheck = await run(['check-ref-format', `refs/tags/${tag}`], { cwd: repo, okCodes: [0, 1, 128] });
    if (refCheck.code !== 0) throw new GitError('そのバージョン名は目印に使えません。', tag);
    if ((await tags(repo)).some((item) => item.name === tag)) throw new GitError(`目印「${tag}」はすでにあります。別のバージョン名を入力してください。`, tag);
  }

  if ((await remotes(repo)).length) {
    await fetch(repo);
    const refreshed = await branches(repo);
    for (const target of targets) {
      const targetBranch = refreshed.local.find((b) => b.name === target);
      if (targetBranch && targetBranch.behind > 0) {
        throw new GitError(`取り込み先「${target}」にサーバー上の更新が ${targetBranch.behind} 件あります。先に「最新を取り込む」で更新してから、もう一度完了してください。`, target);
      }
    }
    if (tag && (await tags(repo)).some((item) => item.name === tag)) throw new GitError(`目印「${tag}」はサーバーにすでにあります。別のバージョン名を入力してください。`, tag);
  }

  for (const target of targets) {
    await switchBranch(repo, target);
    const merged = await merge(repo, branch, { noFastForward: true });
    if (merged && merged.conflict) return { conflict: true, branch, kind, target, targets };
  }
  if (tag) {
    await switchBranch(repo, config.productionBranch);
    await createTag(repo, tag, { message: `${kind}: ${branch}` });
    await switchBranch(repo, config.developmentBranch);
  }
  await deleteBranch(repo, branch);
  await removeTaskBranchBinding(repo, branch);
  return { conflict: false, branch, kind, targets, tag };
}

async function switchBranch(repo, name, { remote = false } = {}) {
  if (remote) {
    const local = name.replace(/^[^/]+\//, '');
    await run(['switch', '--track', '-c', local, name], { cwd: repo });
  } else {
    await run(['switch', name], { cwd: repo });
  }
  return true;
}

async function switchToCommit(repo, hash) { await run(['switch', '--detach', hash], { cwd: repo }); return true; }

async function deleteBranch(repo, name, { force = false } = {}) {
  await run(['branch', force ? '-D' : '-d', name], { cwd: repo });
  return true;
}
async function deleteRemoteBranch(repo, remote, name) {
  await run(['push', remote, '--delete', name], { cwd: repo });
  return true;
}
async function renameBranch(repo, oldName, newName) {
  await validateBranchName(repo, newName);
  await run(['branch', '-m', oldName, newName], { cwd: repo });
  return true;
}

async function merge(repo, name, { noFastForward = false } = {}) {
  const args = ['merge', '--no-edit'];
  if (noFastForward) args.push('--no-ff');
  args.push(name);
  const r = await run(args, { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false, upToDate: /Already up to date/i.test(r.stdout) };
}

async function abortOperation(repo) {
  const st = await status(repo);
  const op = st.operation;
  if (op === 'merge') await run(['merge', '--abort'], { cwd: repo });
  else if (op === 'revert') await run(['revert', '--abort'], { cwd: repo });
  else if (op === 'cherry-pick') await run(['cherry-pick', '--abort'], { cwd: repo });
  else if (op === 'rebase') await run(['rebase', '--abort'], { cwd: repo });
  return true;
}

async function continueOperation(repo, message) {
  const st = await status(repo);
  if (st.files.some((f) => f.conflict)) throw new GitError('ぶつかりが解決されていないファイルがあります。', '');
  const op = st.operation;
  if (op === 'merge') {
    const args = ['commit', '--no-edit'];
    await run(args, { cwd: repo });
  } else if (op === 'revert') await run(['revert', '--continue'], { cwd: repo });
  else if (op === 'cherry-pick') await run(['cherry-pick', '--continue'], { cwd: repo });
  else if (op === 'rebase') await run(['rebase', '--continue'], { cwd: repo });
  return true;
}

/** 'ours' = 自分の版 / 'theirs' = 取り込む側の版 */
async function resolveConflict(repo, file, side) {
  insideRepo(repo, file);
  try {
    await run(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', file], { cwd: repo });
    await run(['add', '--', file], { cwd: repo });
  } catch (e) {
    // 片方が削除していた場合など
    await run(['rm', '-q', '--', file], { cwd: repo });
  }
  return true;
}
async function markResolved(repo, file) { await run(['add', '--', file], { cwd: repo }); return true; }

/* ------------------------------------------------------------------ */
/* 通信（取得 / 取り込み / アップロード）                                */
/* ------------------------------------------------------------------ */
async function remotes(repo) {
  const raw = await out(repo, ['remote', '-v']);
  const map = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], { name: m[1], fetchUrl: '', pushUrl: '' });
    map.get(m[1])[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
  }
  return [...map.values()];
}
async function addRemote(repo, name, url) {
  if (!name || !url) throw new GitError('名前とURLを入力してください。', '');
  await run(['remote', 'add', name.trim(), url.trim()], { cwd: repo });
  return true;
}
async function removeRemote(repo, name) { await run(['remote', 'remove', name], { cwd: repo }); return true; }
async function setRemoteUrl(repo, name, url) { await run(['remote', 'set-url', name, url.trim()], { cwd: repo }); return true; }

async function fetch(repo) {
  const rs = await remotes(repo);
  if (!rs.length) throw new GitError('まだGitHubとつながっていません。先に「アップロード」を押して、GitHubに作成してください。', '');
  await run(['fetch', '--all', '--prune', '--tags'], { cwd: repo });
  return true;
}

/** サーバーに同じ名前の分岐があれば、手元の分岐と結びつける（SourceTreeなど他のツールで取得したフォルダ向け）。結びつけたら true */
async function linkUpstream(repo, st, rs) {
  if (!st) st = await status(repo);
  if (st.upstream) return true;
  if (!st.branch || st.detached) return false;
  rs = rs || await remotes(repo);
  if (!rs.length) return false;
  const remote = (rs.find((r) => r.name === 'origin') || rs[0]).name;
  const f = await run(['fetch', remote, '--prune'], { cwd: repo, okCodes: [0, 1, 128] });
  if (f.code !== 0) return false;
  const has = await run(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${st.branch}`], { cwd: repo, okCodes: [0, 1] });
  if (has.code !== 0) return false;
  if (!st.hasCommits) return false; // 記録がまだ無い場合は、pull 側で取り込みと同時に結びつける
  await run(['branch', `--set-upstream-to=${remote}/${st.branch}`, st.branch], { cwd: repo });
  return true;
}

/** アップロード前の準備：サーバーの更新を確認し、必要なら結びつけて、最新の状態を返す（通信できなくてもエラーにしない） */
async function prepareSync(repo) {
  let st = await status(repo);
  const rs = await remotes(repo);
  if (!rs.length) return st;
  try {
    if (!st.upstream) await linkUpstream(repo, st, rs);
    else await run(['fetch', '--prune'], { cwd: repo, okCodes: [0, 1, 128] });
  } catch (_) { /* 通信できない場合は、あとの操作でエラーを案内する */ }
  return status(repo);
}

async function pull(repo, { allowUnrelated = false } = {}) {
  let st = await status(repo);
  const rs = await remotes(repo);
  if (!rs.length) throw new GitError('まだGitHubとつながっていません。先に「アップロード」を押して、GitHubに作成してください。', '');
  const extra = allowUnrelated ? ['--allow-unrelated-histories'] : [];
  if (!st.upstream) {
    const remote = (rs.find((r) => r.name === 'origin') || rs[0]).name;
    if (!st.hasCommits && st.branch) {
      // 手元にまだ記録がない：サーバーの同名の分岐をそのまま取り込む
      const r = await run(['pull', '--no-rebase', '--no-edit', ...extra, remote, st.branch], { cwd: repo, okCodes: [0, 1] });
      if (r.code !== 0) return conflictOrThrow(repo, r);
      await run(['branch', `--set-upstream-to=${remote}/${st.branch}`, st.branch], { cwd: repo, okCodes: [0, 1] });
      return { conflict: false, upToDate: false };
    }
    if (!(await linkUpstream(repo, st, rs))) {
      await run(['fetch', remote, '--prune'], { cwd: repo }); // 通信できない等の場合は、ここで原因を案内する
      throw new GitError('サーバーには、まだこの作業の分岐がありません。取り込む更新はありません。「アップロード」でサーバーへ送れます。', '');
    }
    st = await status(repo);
  }
  const r = await run(['pull', '--no-rebase', '--no-edit', ...extra], { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false, upToDate: /Already up to date/i.test(r.stdout) };
}

async function push(repo, { force = false, tags = false, setUpstream = false } = {}, onProgress) {
  let st = await status(repo);
  const rs = await remotes(repo);
  if (!rs.length) throw new GitError('アップロード先（接続先）がまだありません。', '');
  if (!st.hasCommits) throw new GitError('まだ記録が1つもありません。先に「変更を記録」してください。', '');
  if (st.detached) throw new GitError('今は特定の記録を見ている状態（分岐の上にいない）ため、アップロードできません。作業の分岐に切り替えてください。', '');
  const args = ['push', '--progress'];
  if (force) args.push('--force-with-lease');
  if (tags) args.push('--tags');
  if (setUpstream || !st.upstream) {
    const remote = (rs.find((r) => r.name === 'origin') || rs[0]).name;
    args.push('--set-upstream', remote, st.branch);
  }
  await run(args, { cwd: repo, onProgress });
  return true;
}

/* ------------------------------------------------------------------ */
/* 一時退避（stash）                                                    */
/* ------------------------------------------------------------------ */
async function stashList(repo) {
  const raw = await out(repo, ['stash', 'list', `--format=%gd${FS}%gs${FS}%cI`]);
  return raw.split('\n').filter(Boolean).map((l) => {
    const [ref, subject, date] = l.split(FS);
    return { ref, subject: subject.replace(/^(WIP on|On) ([^:]+): ?/, '$2： '), raw: subject, date };
  });
}
async function stashSave(repo, { message = '', includeUntracked = true } = {}) {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message.trim()) args.push('-m', message.trim());
  const r = await run(args, { cwd: repo });
  if (/No local changes to save/i.test(r.stdout)) throw new GitError('退避する変更がありません。', r.stdout);
  return true;
}
async function stashApply(repo, ref) {
  const r = await run(['stash', 'apply', ref], { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false };
}
async function stashPop(repo, ref) {
  const r = await run(['stash', 'pop', ref], { cwd: repo, okCodes: [0, 1] });
  if (r.code !== 0) return conflictOrThrow(repo, r);
  return { conflict: false };
}
async function stashDrop(repo, ref) { await run(['stash', 'drop', ref], { cwd: repo }); return true; }
async function stashDiff(repo, ref) { return clip(await out(repo, ['stash', 'show', '-p', '--include-untracked', '--no-color', ref])); }

/* ------------------------------------------------------------------ */
/* 目印（タグ）                                                         */
/* ------------------------------------------------------------------ */
async function tags(repo) {
  const fmt = ['%(refname:short)', '%(objecttype)', '%(subject)', '%(creatordate:iso-strict)', '%(objectname:short)'].join(FS);
  const raw = await out(repo, ['tag', '-l', '--sort=-creatordate', `--format=${fmt}`]);
  return raw.split('\n').filter(Boolean).map((l) => {
    const [name, type, subject, date, sha] = l.split(FS);
    return { name, annotated: type === 'tag', subject, date, sha };
  });
}
async function createTag(repo, name, { hash = null, message = '' } = {}) {
  name = (name || '').trim();
  if (!name) throw new GitError('目印の名前を入力してください。', '');
  if (name.startsWith('-')) throw new GitError('その名前は使えません。（「-」で始まる名前は避けてください）', name);
  const args = ['tag'];
  if (message.trim()) args.push('-a', name, '-m', message.trim()); else args.push(name);
  if (hash) args.push(hash);
  await run(args, { cwd: repo });
  return true;
}
/**
 * リリースの下書き：次のバージョン名の候補と、前のバージョンからの変更点（記録のメモ）を集める。
 * 前のバージョン＝ v1.2.3 / 1.2.3 の形の、いちばん新しい目印。無ければ最初のリリースとして v0.1.0 を提案する。
 */
async function releaseDraft(repo) {
  const all = (await out(repo, ['tag', '-l', '--sort=-v:refname'])).split('\n').filter(Boolean);
  const lastTag = all.find((t) => /^v?\d+\.\d+\.\d+$/.test(t)) || null;
  let suggested = 'v0.1.0';
  if (lastTag) { const m = lastTag.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/); suggested = `${m[1]}${m[2]}.${m[3]}.${Number(m[4]) + 1}`; }
  let commits = [];
  if (await hasCommits(repo)) {
    const r = await run(['log', '--no-merges', '-n', '100', '--format=%h%x09%s', lastTag ? `${lastTag}..HEAD` : 'HEAD'], { cwd: repo, okCodes: [0, 128] });
    commits = r.code === 0 ? r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, ...rest] = l.split('\t'); return { hash, subject: rest.join('\t') }; }) : [];
  }
  const headTags = commits.length || await hasCommits(repo) ? (await out(repo, ['tag', '--points-at', 'HEAD'])).split('\n').filter(Boolean) : []; // 記録がまだ無いときは HEAD が無い
  const notes = commits.length ? '## 変更点\n\n' + commits.map((c) => `- ${c.subject}`).join('\n') + '\n' : '';
  return { lastTag, suggested, commits, headTags, notes };
}
async function deleteTag(repo, name) { await run(['tag', '-d', name], { cwd: repo }); return true; }
async function pushTag(repo, name, remote = 'origin') { await run(['push', remote, `refs/tags/${name}`], { cwd: repo }); return true; }
async function deleteRemoteTag(repo, name, remote = 'origin') { await run(['push', remote, `:refs/tags/${name}`], { cwd: repo }); return true; }

/* ------------------------------------------------------------------ */
/* 設定 / .gitignore                                                    */
/* ------------------------------------------------------------------ */
async function getUser(repo) {
  const get = async (k, scope) => {
    const r = await run(['config', scope, k], { cwd: repo, okCodes: [0, 1] });
    return r.stdout.trim();
  };
  return {
    name: await get('user.name', '--get'), email: await get('user.email', '--get'),
    globalName: await get('user.name', '--global'), globalEmail: await get('user.email', '--global'),
  };
}
async function setUser(repo, { name, email, global = true }) {
  const scope = global ? '--global' : '--local';
  if (name != null) await run(['config', scope, 'user.name', name.trim()], { cwd: repo });
  if (email != null) await run(['config', scope, 'user.email', email.trim()], { cwd: repo });
  return true;
}
/**
 * 名前・メールが「まだ設定されていない場合だけ」書き込む（すでにある設定は絶対に上書きしない）。
 * repo は null でもよい（プロジェクトを開く前でも使える）。
 * 戻り値: { name, email, applied: { name, email } }
 */
async function setUserIfMissing(repo, { name, email } = {}) {
  const cwd = repo || undefined;
  const cur = await getUser(cwd);
  const applied = { name: false, email: false };
  let nm = cur.name || cur.globalName; let em = cur.email || cur.globalEmail;
  if (!nm && name && name.trim()) { await run(['config', '--global', 'user.name', name.trim()], { cwd }); nm = name.trim(); applied.name = true; }
  if (!em && email && email.trim()) { await run(['config', '--global', 'user.email', email.trim()], { cwd }); em = email.trim(); applied.email = true; }
  return { name: nm || '', email: em || '', applied };
}
/* ------------------------------------------------------------------ */
/* アップロード前の安全チェック                                          */
/* ------------------------------------------------------------------ */
/**
 * これから送る記録（まだサーバーにない記録）を調べて、秘密情報や大きすぎるファイルを見つける。
 * 戻り値: { commits, findings: [{ level, kind, label, path, line?, commit?, size?, why? }], contentSkipped }
 *   level: block（送れない）/ danger（漏れるおそれが高い）/ warn（念のため）
 */
async function safetyCheck(repo) {
  const res = { commits: 0, findings: [], contentSkipped: false };
  const st = await status(repo);
  if (!st.hasCommits) return res;
  const range = ['HEAD', '--not', ...(st.upstream ? [st.upstream] : ['--remotes'])];
  res.commits = parseInt((await out(repo, ['rev-list', '--count', ...range])).trim(), 10) || 0;
  if (!res.commits) return res;

  const seen = new Set();
  const add = (f) => { const k = `${f.kind}|${f.label}|${f.path}`; if (seen.has(k) || res.findings.length >= 50) return; seen.add(k); res.findings.push(f); };

  // 1) 送る記録に含まれるファイル（名前・大きさ）
  const objs = await out(repo, ['rev-list', '--objects', ...range]);
  const lines = objs.split('\n').filter((l) => l.includes(' ')).slice(0, 200000);
  let totalBytes = 0;
  if (lines.length) {
    const meta = (await run(['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], { cwd: repo, input: lines.join('\n') + '\n' })).stdout;
    for (const l of meta.split('\n')) {
      const m = l.match(/^blob (\d+) (.+)$/);
      if (!m) continue;
      const size = Number(m[1]); const p = m[2];
      totalBytes += size;
      const lv = safety.checkSize(size);
      if (lv) add({ level: lv, kind: 'size', label: lv === 'block' ? 'GitHubに送れない大きさのファイル' : '大きなファイル', path: p, size });
      const nm = safety.checkName(p);
      if (nm) add({ level: 'danger', kind: 'file', label: nm.label, path: p, why: nm.why });
    }
  }

  // 2) 追加された行の中身（パスワード・キー・秘密鍵）。量が多すぎるときは省略する
  if (totalBytes > 40 * safety.MB) { res.contentSkipped = true; return res; }
  const diff = (await run(['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-filter=AM', '--format=@@@COMMIT %h', ...range], { cwd: repo })).stdout;
  let commit = ''; let file = ''; let ln = 0; let inHeader = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@@COMMIT ')) { commit = l.slice(10).trim(); inHeader = false; continue; }
    if (l.startsWith('diff --git ')) { inHeader = true; file = ''; continue; }
    if (inHeader) {
      if (l.startsWith('+++ ')) { file = l.slice(4).replace(/\t.*$/, '').replace(/^b\//, ''); continue; }
      if (l.startsWith('@@ ')) inHeader = false; else continue;
    }
    if (l.startsWith('@@ ')) { const m = l.match(/\+(\d+)/); ln = m ? Number(m[1]) - 1 : 0; continue; }
    if (l.startsWith('+')) {
      ln++;
      const hit = safety.checkLine(l.slice(1));
      if (hit && file && file !== '/dev/null') add({ level: hit.level, kind: 'secret', label: hit.label, path: file, line: ln, commit });
    }
  }
  return res;
}

async function readIgnore(repo) {
  const p = path.join(repo, '.gitignore');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
async function writeIgnore(repo, text) { fs.writeFileSync(path.join(repo, '.gitignore'), text, 'utf8'); return true; }
const IGNORE_TEMPLATES = {
  node: { label: 'Node.js', lines: ['node_modules/', 'dist/', 'coverage/', '.env', '.env.*', '!.env.example', 'npm-debug.log*'] },
  python: { label: 'Python', lines: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'env/', '.env', '*.egg-info/', 'dist/', 'build/', '.pytest_cache/'] },
  visualstudio: { label: 'Visual Studio / .NET', lines: ['.vs/', 'bin/', 'obj/', 'TestResults/', '*.user', '*.suo'] },
  unity: { label: 'Unity', lines: ['[Ll]ibrary/', '[Tt]emp/', '[Oo]bj/', '[Bb]uild/', '[Bb]uilds/', '[Ll]ogs/', 'UserSettings/'] },
  java: { label: 'Java', lines: ['target/', 'build/', '.gradle/', '*.class', '.idea/'] },
  rust: { label: 'Rust', lines: ['target/'] },
  go: { label: 'Go', lines: ['/bin/', '*.exe', '*.test', '*.out'] },
  web: { label: 'Web（共通）', lines: ['node_modules/', 'dist/', 'coverage/', '.env', '.env.*', '!.env.example'] },
  windows: { label: 'Windows', lines: ['Thumbs.db', 'Thumbs.db:encryptable', 'ehthumbs.db', 'Desktop.ini', '$RECYCLE.BIN/'] },
  macos: { label: 'macOS', lines: ['.DS_Store', '.AppleDouble', '.LSOverride', '._*', '.Spotlight-V100/', '.Trashes/'] },
};
async function ignoreTemplates(_repo) {
  return [{ value: 'none', label: 'テンプレートを選ばない' }, ...Object.entries(IGNORE_TEMPLATES).map(([value, t]) => ({ value, label: t.label }))];
}
async function applyIgnoreTemplate(repo, key) {
  const template = IGNORE_TEMPLATES[key];
  if (!template) throw new GitError('テンプレートを選んでください。', String(key));
  const current = await readIgnore(repo);
  const lines = current.split(/\r?\n/);
  const existing = new Set(lines);
  const additions = template.lines.filter((line) => !existing.has(line));
  if (!additions.length) return { added: 0, text: current };
  const prefix = current && !current.endsWith('\n') ? current + '\n' : current;
  const text = prefix + (current.trim() ? '\n' : '') + additions.join('\n') + '\n';
  await writeIgnore(repo, text);
  return { added: additions.length, text };
}
async function addIgnore(repo, pattern) {
  const cur = await readIgnore(repo);
  const lines = cur.split(/\r?\n/);
  if (lines.includes(pattern)) return true;
  await writeIgnore(repo, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + pattern + '\n');
  return true;
}

module.exports = {
  parseProgress, lfsInfo, lfsTrack,
  GitError, friendly, run, hasCommits,
  checkRepo, init, clone, info, repoNameFromUrl,
  status, diff, applyPatch,
  stage, stageAll, unstage, unstageAll, discard,
  commit, undoLastCommit, lastCommitMessage,
  log, commitFiles, commitDiff, revertCommit, cherryPick, resetTo,
  branches, createBranch, initializeGitFlow, gitFlowConfig, beginGitFlowBranch, finishGitFlowBranch, createTaskBranch, getTaskBranch, bindTaskBranch, removeTaskBranchBinding, switchBranch, switchToCommit, deleteBranch, deleteRemoteBranch, renameBranch,
  merge, abortOperation, continueOperation, resolveConflict, markResolved,
  remotes, addRemote, removeRemote, setRemoteUrl, fetch, linkUpstream, prepareSync, pull, push,
  stashList, stashSave, stashApply, stashPop, stashDrop, stashDiff,
  tags, createTag, releaseDraft, deleteTag, pushTag, deleteRemoteTag,
  getUser, setUser, setUserIfMissing, safetyCheck, readIgnore, writeIgnore, addIgnore, ignoreTemplates, applyIgnoreTemplate,
};
