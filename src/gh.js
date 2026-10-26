'use strict';
/**
 * GitHub 連携層（GitHub CLI `gh` を利用）。
 * ログイン・リポジトリ作成・変更の提案（プルリクエスト）・課題（Issue）を日本語のエラーで扱う。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { classifyAuth } = require('./auth-errors');

class GhError extends Error {
  constructor(message, detail, code) {
    super(message);
    this.name = 'GhError';
    this.detail = detail || '';
    this.exitCode = code;
    this.kind = classifyAuth(detail); // 'auth'（ログイン切れ）/ 'ssh' / ''。画面側が再ログインへ案内するのに使う
  }
}

const RULES = [
  [/release with the same tag name already exists|tag_name.*already_exists/i,
    'その名前のリリースは、すでにGitHubにあります。別のバージョン名にしてください。'],
  [/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|To get started with GitHub CLI/i,
    'GitHubにログインしていません。「GitHub」画面からログインしてください。'],
  [/Could not resolve host|dial tcp|network is unreachable|timeout/i,
    'ネットワークにつながりませんでした。インターネット接続を確認してください。'],
  [/Name already exists|already exists on this account|name already exists/i,
    '同じ名前のリポジトリがすでにGitHubにあります。別の名前にしてください。'],
  [/Validation Failed|cannot be invited|is already a collaborator|Repository owner cannot/i,
    'この人は招待できません。（自分自身や、すでにメンバーの人は招待できません）'],
  [/Could not resolve to a Repository|HTTP 404|Not Found/i,
    '見つかりませんでした。リポジトリがGitHub上に存在しないか、権限がない可能性があります。'],
  [/no pull requests found|no open pull requests/i,
    '該当する変更の提案はありません。'],
  [/a pull request for branch .* already exists/i,
    'この作業の分岐からの変更の提案は、すでに作成されています。'],
  [/must first push the current branch|has not been pushed|head branch .* is not|No commits between/i,
    '先に「アップロード」して、GitHubへ作業内容を送ってから実行してください。（または、比べる相手との違いがありません）'],
  [/not a git repository/i, 'ここは Git で管理されているフォルダではありません。'],
  [/Pull request is not mergeable|not mergeable|merge conflict/i,
    'ぶつかりがあるため、このままでは取り込めません。'],
  [/HTTP 403|Resource not accessible|must have admin rights|Forbidden/i,
    'この操作を行う権限がありません。'],
  [/Repository has disabled issues|has disabled issues/i,
    'このリポジトリでは Issue が無効になっています。'],
];

function friendly(text) {
  for (const [re, msg] of RULES) if (re.test(text)) return msg;
  return 'GitHubとのやりとりでエラーが発生しました。「くわしい内容」を確認してください。';
}

function baseEnv() {
  const env = { ...process.env };
  env.GH_PROMPT_DISABLED = '1';
  env.NO_COLOR = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.GH_SPINNER_DISABLED = '1';
  env.LC_MESSAGES = 'C';
  env.LANGUAGE = 'C';
  return env;
}

function run(args, { cwd, input, okCodes = [0], env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('gh', args, { cwd, env: { ...baseEnv(), ...(env || {}) }, windowsHide: true }); }
    catch (e) { return reject(new GhError('GitHub CLI（gh）が見つかりません。', String(e))); }
    const o = []; const e = [];
    child.stdout.on('data', (d) => o.push(d));
    child.stderr.on('data', (d) => e.push(d));
    child.on('error', (err) => {
      if (err.code === 'ENOENT') reject(new GhError('GitHub CLI（gh）が見つかりません。https://cli.github.com/ からインストールしてください。', String(err), 'ENOENT'));
      else reject(new GhError('gh を実行できませんでした。', String(err)));
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(o).toString('utf8');
      const stderr = Buffer.concat(e).toString('utf8');
      if (okCodes.includes(code)) return resolve({ stdout, stderr, code });
      reject(new GhError(friendly(stderr + stdout), (stderr + '\n' + stdout).trim(), code));
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const json = async (args, opts) => {
  const r = await run(args, opts);
  try { return JSON.parse(r.stdout || 'null'); } catch (e) { throw new GhError('GitHubからの応答を読み取れませんでした。', r.stdout); }
};

/* ------------------------- gh の自動インストール ------------------------- */
/** アプリから起動すると PATH が狭いため、gh が入りやすい場所を検索パスに足す */
function extendPath() {
  if (process.env.YG_NO_PATH_EXTEND) return; // テスト用：検索パスの補正を無効にする
  const sep = path.delimiter;
  const local = process.env.LOCALAPPDATA || '';
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
    : process.platform === 'win32' ? ['C:\\Program Files\\GitHub CLI', 'C:\\Program Files (x86)\\GitHub CLI', local && path.join(local, 'Programs', 'GitHub CLI', 'bin'), local && path.join(local, 'GitHub CLI')]
    : ['/usr/local/bin', '/snap/bin', '/home/linuxbrew/.linuxbrew/bin'];
  const cur = (process.env.PATH || '').split(sep);
  process.env.PATH = [...cur, ...extra.filter((d) => d && !cur.includes(d))].join(sep);
}
extendPath();

const exists = (cmd, args = ['--version']) => new Promise((resolve) => {
  try {
    const c = spawn(cmd, args, { windowsHide: true, env: process.env });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
    c.stdout.resume(); c.stderr.resume();
  } catch (_) { resolve(false); }
});

/** どの方法でインストールできるか。method: winget | brew | manual */
async function installPlan() {
  extendPath();
  if (process.platform === 'win32' && await exists('winget')) return { method: 'winget', label: 'インストールする', canAuto: true };
  if (process.platform === 'darwin' && await exists('brew')) return { method: 'brew', label: 'インストールする', canAuto: true };
  return { method: 'manual', label: 'ダウンロードページを開く', canAuto: false, url: 'https://cli.github.com/' };
}

const WINGET_ALREADY = [-1978335189, -1978335135, 2316632107, 2316632161]; // 既に導入済み・更新なし等

/** gh を自動インストールして、使えるか確認する */
async function installCli() {
  const plan = await installPlan();
  if (!plan.canAuto) throw new GhError('このパソコンでは自動インストールに対応していません。ダウンロードページから入れてください。', '');
  const [cmd, args] = plan.method === 'winget'
    ? ['winget', ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent']]
    : ['brew', ['install', 'gh']];
  const r = await new Promise((resolve) => {
    const o = [];
    let c;
    try { c = spawn(cmd, args, { windowsHide: true, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } }); } catch (e) { return resolve({ code: -1, log: String(e) }); }
    c.stdout.on('data', (d) => o.push(d)); c.stderr.on('data', (d) => o.push(d));
    c.on('error', (e) => resolve({ code: -1, log: String(e) }));
    c.on('close', (code) => resolve({ code, log: Buffer.concat(o).toString('utf8') }));
  });
  extendPath();
  const a = await available();
  if (a.installed) return { installed: true, version: a.version };
  if (r.code === 0 || WINGET_ALREADY.includes(r.code)) {
    throw new GhError('インストールは完了しましたが、まだ認識できません。アプリを一度閉じて、もう一度開いてください。', r.log, r.code);
  }
  throw new GhError('自動インストールに失敗しました。管理者の許可が必要だった可能性があります。ダウンロードページから手動で入れることもできます。', r.log, r.code);
}

/* ------------------------------ ログイン ------------------------------ */
async function available() {
  try { const r = await run(['--version']); return { installed: true, version: r.stdout.split('\n')[0] }; }
  catch (e) { return { installed: false, version: '', message: e.message }; }
}

let gitCredReady = false;
/** git が使うログイン情報の設定を、もう一度やり直す（Windows の古い保存済みパスワードなどに負けないように） */
async function refreshGitCredentials() {
  gitCredReady = false;
  await ensureGitCredentials();
  return true;
}
/** git が GitHub の認証に gh のログイン情報を使うようにする（1回だけ） */
async function ensureGitCredentials() {
  if (gitCredReady) return;
  gitCredReady = true;
  await run(['auth', 'setup-git', '--hostname', 'github.com'], { okCodes: [0, 1] }).catch(() => {});
}

/**
 * ログイン状態。保存済みのトークンがあれば「ログイン済み」とみなす（オフラインでも使えるように）。
 * ただし、GitHub側で無効になっていると分かった場合だけ「未ログイン」にする。
 */
async function authStatus() {
  const a = await available();
  const version = (a.version.match(/\b(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  const supportsMultipleAccounts = version.length === 3 && (version[0] > 2 || (version[0] === 2 && version[1] >= 40));
  if (!a.installed) return { installed: false, loggedIn: false, message: a.message, supportsMultipleAccounts: false };
  let accounts = [];
  try {
    const status = await json(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
    const hostAccounts = status?.hosts?.['github.com'];
    if (Array.isArray(hostAccounts)) accounts = hostAccounts
      .filter((account) => account && account.login)
      .map((account) => ({ login: account.login, active: !!account.active, state: account.state || '' }));
  } catch (_) { /* 古い gh でも従来のログイン状態確認を続ける */ }
  const tok = await run(['auth', 'token', '--hostname', 'github.com'], { okCodes: [0, 1, 2] });
  const hasToken = tok.code === 0 && tok.stdout.trim().length > 0;
  if (!hasToken) return { installed: true, loggedIn: false, accounts, cliVersion: a.version, supportsMultipleAccounts };
  const st = await run(['auth', 'status', '--hostname', 'github.com'], { okCodes: [0, 1] });
  if (st.code !== 0 && /invalid|expired|revoked|Bad credentials|HTTP 401|failed to log in/i.test(st.stderr + st.stdout)) {
    return { installed: true, loggedIn: false, expired: true, accounts, cliVersion: a.version, supportsMultipleAccounts };
  }
  let login = '';
  try { login = (await run(['api', 'user', '--jq', '.login'])).stdout.trim(); } catch (_) { /* オフライン等 */ }
  if (login && !accounts.some((account) => account.login.toLowerCase() === login.toLowerCase())) accounts.unshift({ login, active: true, state: 'success' });
  if (login && accounts.length) accounts = accounts.map((account) => ({ ...account, active: account.login.toLowerCase() === login.toLowerCase() }));
  await ensureGitCredentials();
  return { installed: true, loggedIn: true, login, accounts, cliVersion: a.version, supportsMultipleAccounts };
}

async function switchAccount(login) {
  const a = await available();
  const version = (a.version.match(/\b(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  if (version.length !== 3 || (version[0] < 2 || (version[0] === 2 && version[1] < 40))) throw new GhError('複数アカウントの切り替えには GitHub CLI 2.40 以降が必要です。GitHub CLIを更新してください。', a.version);
  login = String(login || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new GhError('GitHubのユーザー名を確認できません。', login);
  const accounts = await json(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
  const hostAccounts = accounts?.hosts?.['github.com'];
  if (!Array.isArray(hostAccounts) || !hostAccounts.some((account) => account.login?.toLowerCase() === login.toLowerCase())) {
    throw new GhError('このGitHubアカウントは登録されていません。', login);
  }
  await run(['auth', 'switch', '--hostname', 'github.com', '--user', login]);
  await run(['auth', 'setup-git', '--hostname', 'github.com'], { okCodes: [0, 1] });
  gitCredReady = true;
  return authStatus();
}

async function loginWithToken(_cwd, token) {
  token = (token || '').trim();
  if (!token) throw new GhError('トークンを入力してください。', '');
  try { await run(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'], { input: token + '\n' }); }
  catch (e) { if (e instanceof GhError) { e.kind = ''; } throw e; } // ログイン操作そのものの失敗は「ログイン切れ」の案内の対象にしない
  await run(['auth', 'setup-git', '--hostname', 'github.com'], { okCodes: [0, 1] });
  return authStatus();
}

/** ブラウザ認証。onCode(コード) でワンタイムコードを画面へ通知する。 */
let loginChild = null;
function cancelLogin() { if (loginChild) { try { loginChild.kill(); } catch (_) { /* 無視 */ } loginChild = null; } return true; }
/** ログインで求める権限。workflow は、.github/workflows のファイル（自動ビルドの設定）を送るのに必要 */
const LOGIN_SCOPES = 'repo,read:org,workflow';
function loginWeb(onCode) {
  cancelLogin();
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--scopes', LOGIN_SCOPES], { env: baseEnv(), windowsHide: true });
    loginChild = child;
    let buf = '';
    let sent = false;
    const onData = (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (m && !sent) {
        sent = true;
        if (onCode) onCode(m[1]);
        try { child.stdin.write('\n'); } catch (_) { /* 無視 */ }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new GhError('gh を実行できませんでした。', String(e))));
    child.on('close', async (code) => {
      if (loginChild === child) loginChild = null;
      if (child.killed) return reject(Object.assign(new GhError('ログインを中止しました。', buf, code), { kind: '' }));
      if (code === 0) {
        await run(['auth', 'setup-git', '--hostname', 'github.com'], { okCodes: [0, 1] }).catch(() => {});
        resolve(await authStatus());
      } else reject(Object.assign(new GhError('ログインが完了しませんでした。もう一度お試しください。', buf, code), { kind: '' }));
    });
    child.stdin.on('error', () => {});
  });
}

async function logout(login) {
  const args = ['auth', 'logout', '--hostname', 'github.com'];
  if (login) args.push('--user', String(login));
  await run(args, { okCodes: [0, 1] });
  return authStatus();
}

/* ---------------------------- リポジトリ ---------------------------- */
/** 自分のもの・招待されたもの・所属チーム（Organization）のプロジェクトを新しい順に。permission: admin | write | read */
async function listRepos() {
  const r = await run(['api', '--paginate', 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    '--jq', '.[] | {nameWithOwner: .full_name, description: .description, isPrivate: .private, url: .html_url, updatedAt: .updated_at, isFork: .fork, permission: (if .permissions.admin then "admin" elif .permissions.push then "write" else "read" end), owner: .owner.login}']);
  return jsonLines(r.stdout).slice(0, 300);
}

async function createRepo(cwd, { name, description = '', isPrivate = true } = {}) {
  name = (name || '').trim();
  if (!name) throw new GhError('リポジトリ名を入力してください。', '');
  const args = ['repo', 'create', name, isPrivate ? '--private' : '--public', '--source', '.', '--remote', 'origin'];
  if (description.trim()) args.push('--description', description.trim());
  const r = await run(args, { cwd });
  return { url: (r.stdout.match(/https:\/\/github\.com\/\S+/) || [''])[0] };
}

/** GitHubリポジトリの公開範囲を切り替える（管理者権限が必要） */
async function setRepoVisibility(ref, isPrivate) {
  ref = checkRef(ref);
  if (typeof isPrivate !== 'boolean') throw new GhError('公開範囲の指定が正しくありません。', String(isPrivate));
  const updated = await json(['api', '-X', 'PATCH', `repos/${ref}`, '-F', `private=${isPrivate}`]);
  if (typeof updated.private !== 'boolean') throw new GhError('GitHubで公開範囲を変更できたか確認できませんでした。', JSON.stringify(updated));
  return { isPrivate: updated.private };
}

async function currentRepo(cwd) {
  try { return await json(['repo', 'view', '--json', 'nameWithOwner,url,description,isPrivate,defaultBranchRef'], { cwd }); }
  catch (e) { return null; }
}

const repoInfoCache = new Map();
async function commitAuthorAvatar(cwd, hash) {
  if (!/^[a-f0-9]{7,40}$/i.test(String(hash || ''))) return null;
  if (!repoInfoCache.has(cwd)) repoInfoCache.set(cwd, currentRepo(cwd));
  const repo = await repoInfoCache.get(cwd);
  if (!repo || !repo.nameWithOwner) return null;
  checkRef(repo.nameWithOwner);
  const r = await run(['api', `repos/${repo.nameWithOwner}/commits/${hash}`, '--jq', '.author.avatar_url // empty'], { cwd });
  return r.stdout.trim() || null;
}

/* ------------------------ 変更の提案（PR） ------------------------ */
const PR_FIELDS = 'number,title,author,state,url,headRefName,baseRefName,isDraft,createdAt,updatedAt,mergeable,reviewDecision';
async function listPRs(cwd, state = 'open') {
  return json(['pr', 'list', '--state', state, '--limit', '50', '--json', PR_FIELDS], { cwd });
}
async function viewPR(cwd, number) {
  return json(['pr', 'view', String(number), '--json', PR_FIELDS + ',body,mergeable,reviewDecision,additions,deletions,changedFiles,comments,reviews'], { cwd });
}
async function diffPR(cwd, number) {
  const r = await run(['pr', 'diff', String(number), '--color', 'never'], { cwd });
  return r.stdout;
}
async function findPRForBranch(cwd, branch) {
  branch = String(branch || '').trim();
  if (!branch) return null;
  const list = await json(['pr', 'list', '--state', 'all', '--head', branch, '--limit', '10', '--json', PR_FIELDS], { cwd });
  return (list || []).find((pr) => pr.headRefName === branch) || null;
}
async function createPR(cwd, { title, body = '', base, head, draft = false } = {}) {
  if (!title || !title.trim()) throw new GhError('タイトルを入力してください。', '');
  const args = ['pr', 'create', '--title', title.trim(), '--body', body];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);
  if (draft) args.push('--draft');
  const r = await run(args, { cwd });
  return { url: (r.stdout.match(/https:\/\/\S+/) || [''])[0] };
}
/** method: merge | squash | rebase */
async function mergePR(cwd, number, method = 'merge', deleteBranch = false) {
  const args = ['pr', 'merge', String(number), `--${method}`];
  if (deleteBranch) args.push('--delete-branch');
  await run(args, { cwd });
  return true;
}
async function closePR(cwd, number) { await run(['pr', 'close', String(number)], { cwd }); return true; }
async function reopenPR(cwd, number) { await run(['pr', 'reopen', String(number)], { cwd }); return true; }
async function checkoutPR(cwd, number) { await run(['pr', 'checkout', String(number)], { cwd }); return true; }
async function commentPR(cwd, number, body) { await run(['pr', 'comment', String(number), '--body', body], { cwd }); return true; }
/** PRの作業ブランチに本流の最新内容を取り込み、競合解消を促す */
async function updatePRBranch(cwd, number) { await run(['pr', 'update-branch', String(number)], { cwd }); return true; }
/** PRのレビュー担当者を指定する */
async function requestPRReview(cwd, number, reviewers) {
  const names = [...new Set((Array.isArray(reviewers) ? reviewers : String(reviewers || '').split(',')).map((x) => String(x).trim().replace(/^@/, '')).filter((x) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(x)))];
  if (!names.length) throw new GhError('GitHubのユーザー名を入力してください。', '');
  await run(['pr', 'edit', String(number), ...names.flatMap((name) => ['--add-reviewer', name])], { cwd }); return true;
}
/** レビュー結果をGitHubに送る。レビュー承認などはGitHubの権限ルールに従う */
async function reviewPR(cwd, number, decision, body = '') {
  const action = { approve: '--approve', changes: '--request-changes', comment: '--comment' }[decision];
  if (!action) throw new GhError('レビューの操作を選び直してください。', String(decision));
  await run(['pr', 'review', String(number), action, ...(body.trim() ? ['--body', body.trim()] : [])], { cwd }); return true;
}

/* ------------------------- 課題・相談（Issue） ------------------------- */
const ISSUE_FIELDS = 'number,title,author,state,url,labels,createdAt,updatedAt,comments';
async function listIssues(cwd, state = 'open') {
  return json(['issue', 'list', '--state', state, '--limit', '50', '--json', ISSUE_FIELDS], { cwd });
}
async function viewIssue(cwd, number) {
  return json(['issue', 'view', String(number), '--json', ISSUE_FIELDS + ',body'], { cwd });
}
async function createIssue(cwd, { title, body = '' } = {}) {
  if (!title || !title.trim()) throw new GhError('タイトルを入力してください。', '');
  const r = await run(['issue', 'create', '--title', title.trim(), '--body', body], { cwd });
  return { url: (r.stdout.match(/https:\/\/\S+/) || [''])[0] };
}
async function closeIssue(cwd, number) { await run(['issue', 'close', String(number)], { cwd }); return true; }
async function reopenIssue(cwd, number) { await run(['issue', 'reopen', String(number)], { cwd }); return true; }
/** GitHub Issueを完全に削除する（GitHub側の権限が必要。復元不可） */
async function deleteIssue(cwd, number) {
  const n = String(Number(number));
  if (!/^\d+$/.test(n) || Number(n) < 1) throw new GhError('タスク番号が正しくありません。', String(number));
  const issue = await json(['api', `repos/{owner}/{repo}/issues/${n}`], { cwd });
  if (!issue || !issue.node_id) throw new GhError('GitHubからタスクの情報を取得できませんでした。', 'Issue node_id is missing');
  const result = await json(['api', 'graphql', '-f', 'query=mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { repository { id } } }', '-F', `issueId=${issue.node_id}`], { cwd });
  if (result && result.errors && result.errors.length) {
    const detail = result.errors.map((e) => e.message).join('\n');
    throw new GhError(friendly(detail), detail);
  }
  if (!result || !result.data || !result.data.deleteIssue) throw new GhError('GitHubでタスクを削除できたか確認できませんでした。', JSON.stringify(result));
  return true;
}
async function commentIssue(cwd, number, body) { await run(['issue', 'comment', String(number), '--body', body], { cwd }); return true; }

/* ------------------------- やさしいGit フォーラム ------------------------- */
const FEEDBACK_REPO = 'rumo-dev/yasashii-git';
async function forumList(state = 'open') {
  return json(['issue', 'list', '--repo', FEEDBACK_REPO, '--state', state, '--limit', '50', '--json', ISSUE_FIELDS]);
}
async function forumCreate({ category, title, body = '' } = {}) {
  if (!title || !title.trim()) throw new GhError('タイトルを入力してください。', '');
  const prefix = category === 'feature' ? '[要望] ' : category === 'other' ? '[相談] ' : '[バグ] ';
  const r = await run(['issue', 'create', '--repo', FEEDBACK_REPO, '--title', prefix + title.trim(), '--body', body]);
  return { url: (r.stdout.match(/https:\/\/\S+/) || [''])[0] };
}
async function forumComment(number, body) {
  await run(['issue', 'comment', String(number), '--repo', FEEDBACK_REPO, '--body', body]);
  return true;
}


/* ------------------------- タスク管理（Issueを「未着手／進行中／完了」で管理） ------------------------- */
const DOING_LABEL = '進行中';
const REVIEW_LABEL = 'レビュー待ち';
const PRIORITY_LABELS = { high: '緊急度:高', normal: '緊急度:中', low: '緊急度:低' };
const TASK_FIELDS = 'number,title,author,state,url,labels,assignees,createdAt,updatedAt,closedAt,comments,body';
/** 「進行中」の目印（ラベル）がなければ作る。あれば何もしない */
async function ensureDoingLabel(cwd) {
  await run(['label', 'create', DOING_LABEL, '--color', 'fbca04', '--description', 'いま取りかかっているタスク', '--force'], { cwd });
}
async function ensureReviewLabel(cwd) {
  await run(['label', 'create', REVIEW_LABEL, '--color', '5319e7', '--description', '変更の提案がレビュー待ち', '--force'], { cwd });
}
/** タスク一覧。status: todo(未着手) | doing(進行中) | done(完了) を付けて返す */
async function listTasks(cwd) {
  const list = await json(['issue', 'list', '--state', 'all', '--limit', '200', '--json', TASK_FIELDS], { cwd });
  return (list || []).map((i) => {
    const doing = (i.labels || []).some((l) => l.name === DOING_LABEL);
    const review = (i.labels || []).some((l) => l.name === REVIEW_LABEL);
    const status = i.state === 'CLOSED' ? 'done' : review ? 'review' : doing ? 'doing' : 'todo';
    const priorityLabel = (i.labels || []).find((l) => Object.values(PRIORITY_LABELS).includes(l.name));
    const priority = Object.keys(PRIORITY_LABELS).find((key) => PRIORITY_LABELS[key] === (priorityLabel && priorityLabel.name)) || 'normal';
    return { ...i, status, priority, comments: (i.comments || []).length };
  });
}
/** cur: { state: 'OPEN'|'CLOSED', doing: boolean, review: boolean } */
async function setTaskStatus(cwd, number, status, cur = {}) {
  const n = String(Number(number));
  if (!['todo', 'doing', 'review', 'done'].includes(status)) throw new GhError('状態の指定が正しくありません。', String(status));
  if (status === 'done') {
    if (cur.doing) await run(['issue', 'edit', n, '--remove-label', DOING_LABEL], { cwd });
    if (cur.review) await run(['issue', 'edit', n, '--remove-label', REVIEW_LABEL], { cwd });
    if (cur.state !== 'CLOSED') await run(['issue', 'close', n], { cwd });
    return true;
  }
  if (cur.state === 'CLOSED') await run(['issue', 'reopen', n], { cwd });
  if (status === 'doing') {
    if (!cur.doing) { await ensureDoingLabel(cwd); await run(['issue', 'edit', n, '--add-label', DOING_LABEL], { cwd }); }
  } else if (cur.doing) {
    await run(['issue', 'edit', n, '--remove-label', DOING_LABEL], { cwd });
  }
  if (status === 'review') {
    if (!cur.review) { await ensureReviewLabel(cwd); await run(['issue', 'edit', n, '--add-label', REVIEW_LABEL], { cwd }); }
  } else if (cur.review) {
    await run(['issue', 'edit', n, '--remove-label', REVIEW_LABEL], { cwd });
  }
  return true;
}
/** 担当を自分にする／外す */
async function assignTaskToMe(cwd, number, on = true) {
  await run(['issue', 'edit', String(Number(number)), on ? '--add-assignee' : '--remove-assignee', '@me'], { cwd });
  return true;
}
async function createTask(cwd, { title, body = '', status = 'todo', priority = 'normal', assignMe = false } = {}) {
  if (!title || !title.trim()) throw new GhError('タイトルを入力してください。', '');
  const args = ['issue', 'create', '--title', title.trim(), '--body', body];
  if (assignMe) args.push('--assignee', '@me');
  if (status === 'doing') { await ensureDoingLabel(cwd); args.push('--label', DOING_LABEL); }
  const priorityLabel = PRIORITY_LABELS[priority] || PRIORITY_LABELS.normal;
  await run(['label', 'create', priorityLabel, '--color', priority === 'high' ? 'd73a4a' : priority === 'low' ? '0e8a16' : 'fbca04', '--description', 'タスクの緊急度', '--force'], { cwd });
  args.push('--label', priorityLabel);
  const r = await run(args, { cwd });
  return { url: (r.stdout.match(/https:\/\/\S+/) || [''])[0] };
}
async function editTask(cwd, number, { title, body } = {}) {
  const args = ['issue', 'edit', String(Number(number))];
  if (title != null) { if (!title.trim()) throw new GhError('タイトルを入力してください。', ''); args.push('--title', title.trim()); }
  if (body != null) args.push('--body', body);
  await run(args, { cwd });
  return true;
}

/* ------------------------------ チーム（メンバーと招待） ------------------------------ */
function jsonLines(text) {
  return (text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
const REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function checkRef(ref) { if (!REF.test(ref || '')) throw new GhError('プロジェクトの指定が正しくありません。', String(ref)); return ref; }
function checkUser(u) {
  u = String(u || '').trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!u) throw new GhError('招待したい人の GitHub ユーザー名を入力してください。', '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(u)) throw new GhError('GitHub のユーザー名の形式が正しくありません。（半角の英数字と - だけです）', u);
  return u;
}

/** プロジェクトに今いるメンバー */
async function listMembers(ref) {
  checkRef(ref);
  const r = await run(['api', '--paginate', `repos/${ref}/collaborators?per_page=100`,
    '--jq', '.[] | {login: .login, url: .html_url, role: (if .permissions.admin then "admin" elif .permissions.push then "write" else "read" end)}']);
  return jsonLines(r.stdout);
}
/** 送った招待のうち、まだ返事がないもの */
async function listSentInvites(ref) {
  checkRef(ref);
  const r = await run(['api', '--paginate', `repos/${ref}/invitations?per_page=100`,
    '--jq', '.[] | {id: .id, login: .invitee.login, role: (if .permissions == "admin" then "admin" elif (.permissions == "write" or .permissions == "maintain") then "write" else "read" end), createdAt: .created_at}']);
  return jsonLines(r.stdout);
}
/** role: write（編集できる）| read（見るだけ）| admin（管理者） */
async function inviteMember(ref, username, role = 'write') {
  checkRef(ref); const u = checkUser(username);
  const permission = { write: 'push', read: 'pull', admin: 'admin' }[role] || 'push';
  try {
    const r = await run(['api', '-X', 'PUT', `repos/${ref}/collaborators/${u}`, '-f', `permission=${permission}`]);
    return { login: u, invited: /"id"\s*:/.test(r.stdout), url: `https://github.com/${ref}/invitations` };
  } catch (e) {
    if (e instanceof GhError && /HTTP 404|Not Found/i.test(e.detail) && !/repos\//.test(e.message)) throw new GhError('その名前の GitHub アカウントが見つからないか、このプロジェクトに人を招待する権限がありません。ユーザー名と、自分が管理者かどうかを確認してください。', e.detail, e.exitCode);
    throw e;
  }
}
async function cancelSentInvite(ref, id) { checkRef(ref); await run(['api', '-X', 'DELETE', `repos/${ref}/invitations/${Number(id)}`]); return true; }
async function removeMember(ref, username) { checkRef(ref); await run(['api', '-X', 'DELETE', `repos/${ref}/collaborators/${checkUser(username)}`]); return true; }

/** 自分に届いている招待 */
async function myInvites() {
  const r = await run(['api', '--paginate', 'user/repository_invitations?per_page=100',
    '--jq', '.[] | {id: .id, repo: .repository.full_name, url: .repository.html_url, inviter: .inviter.login, role: (if .permissions == "admin" then "admin" elif (.permissions == "write" or .permissions == "maintain") then "write" else "read" end), createdAt: .created_at}']);
  return jsonLines(r.stdout);
}
async function acceptInvite(id) { await run(['api', '-X', 'PATCH', `user/repository_invitations/${Number(id)}`]); return true; }
async function declineInvite(id) { await run(['api', '-X', 'DELETE', `user/repository_invitations/${Number(id)}`]); return true; }

/** リンクで渡されたプロジェクトに入れるか調べる。{ ok, ref, url, permission } / 入れない場合は、招待が届いていればその情報も返す */
async function checkAccess(ref) {
  checkRef(ref);
  try {
    const v = await json(['repo', 'view', ref, '--json', 'nameWithOwner,url,viewerPermission,isPrivate']);
    return { ok: true, ref: v.nameWithOwner, url: v.url, permission: v.viewerPermission, isPrivate: v.isPrivate };
  } catch (e) {
    let invite = null;
    try { invite = (await myInvites()).find((i) => i.repo.toLowerCase() === ref.toLowerCase()) || null; } catch (_) { /* 無視 */ }
    return { ok: false, ref, invite, message: e.message };
  }
}
/** 自分の GitHub ユーザー名（招待してもらうときに相手へ伝える） */
async function myLogin() { return (await run(['api', 'user', '--jq', '.login'])).stdout.trim(); }

/**
 * 自分の GitHub アカウント情報から、「記録に残す名前とメール」の候補を作る。
 * メールは GitHub の非公開用アドレス（<id>+<ユーザー名>@users.noreply.github.com）を使う。
 * → 本当のメールアドレスが公開されず、GitHub上でも自分の記録として表示され、「メールを公開する設定」で送信が拒否されることもない。
 */
async function myProfile() {
  const j = await json(['api', 'user']);
  const login = String((j && j.login) || '').trim();
  if (!login) throw new GhError('GitHubのアカウント情報を取得できませんでした。', JSON.stringify(j));
  const name = String((j && j.name) || '').trim() || login;
  const id = Number(j && j.id);
  const email = id > 0 ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  return { login, name, email };
}

/* ------------------------------ リリース ------------------------------ */
async function listReleases(cwd) {
  return json(['release', 'list', '--limit', '30', '--json', 'tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt'], { cwd });
}
/** GitHub のリリースを作る。目印（タグ）は、先にサーバーへ送ってある前提（--verify-tag） */
async function createRelease(cwd, { tag, title = '', notes = '', draft = false, prerelease = false } = {}) {
  tag = (tag || '').trim();
  if (!tag) throw new GhError('バージョン名を入力してください。', '');
  if (tag.startsWith('-') || /\s/.test(tag)) throw new GhError('バージョン名に空白や、先頭の「-」は使えません。', tag);
  const args = ['release', 'create', tag, '--title', (title || tag).trim(), '--notes', notes || '', '--verify-tag'];
  if (draft) args.push('--draft');
  if (prerelease) args.push('--prerelease');
  const r = await run(args, { cwd });
  return { url: (r.stdout.match(/https:\/\/\S+/) || [''])[0] };
}

/* ------------------------------ GitHub Actions ------------------------------ */
const ACTIONS_TEMPLATES = {
  manual: {
    filename: 'manual.yml', label: '手動実行できる最小例',
    content: `name: 手動で試す\n\non:\n  workflow_dispatch:\n\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - name: メッセージを表示\n        run: echo "GitHub Actions が動きました"\n`,
  },
  node: {
    filename: 'node-ci.yml', label: 'Node.js のテスト',
    content: `name: Node.js のテスト\n\non:\n  push:\n  pull_request:\n  workflow_dispatch:\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n      - run: npm test\n`,
  },
  python: {
    filename: 'python-ci.yml', label: 'Python のテスト',
    content: `name: Python のテスト\n\non:\n  push:\n  pull_request:\n  workflow_dispatch:\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.x'\n      - run: python -m unittest discover\n`,
  },
};
const ACTIONS_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/i;
function actionsDir(cwd, create = false) {
  if (!cwd) throw new GhError('プロジェクトのフォルダを確認できません。', '');
  const root = fs.realpathSync(cwd);
  let parent = root;
  for (const name of ['.github', 'workflows']) {
    const next = require('path').join(parent, name);
    if (!fs.existsSync(next)) {
      if (!create) return null;
      fs.mkdirSync(next);
    }
    const st = fs.lstatSync(next);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GhError('ワークフローの保存先が安全なフォルダではありません。', next);
    parent = next;
  }
  return parent;
}
function actionsFile(cwd, filename, createDir = false) {
  filename = String(filename || '');
  if (!ACTIONS_FILE.test(filename) || filename === '.' || filename === '..') throw new GhError('ワークフローファイル名は英数字・ハイフン・アンダースコアで指定してください。（.yml または .yaml）', filename);
  const dir = actionsDir(cwd, createDir);
  if (!dir) return null;
  const target = require('path').join(dir, filename);
  if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile())) throw new GhError('ワークフローファイルが安全なファイルではありません。', filename);
  return target;
}
function listLocalActionsWorkflows(cwd) {
  const dir = actionsDir(cwd);
  if (!dir) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && ACTIONS_FILE.test(d.name))
    .map((d) => ({ filename: d.name, size: fs.statSync(require('path').join(dir, d.name)).size }));
}
function readLocalActionsWorkflow(cwd, filename) {
  const file = actionsFile(cwd, filename);
  if (!file || !fs.existsSync(file)) throw new GhError('ワークフローファイルが見つかりません。', String(filename));
  const st = fs.statSync(file);
  if (st.size > 262144) throw new GhError('このワークフローファイルは大きすぎて編集できません。（上限 256KB）', filename);
  return { filename, content: fs.readFileSync(file, 'utf8') };
}
function saveLocalActionsWorkflow(cwd, filename, content) {
  const file = actionsFile(cwd, filename, true);
  content = String(content == null ? '' : content);
  if (Buffer.byteLength(content, 'utf8') > 262144) throw new GhError('ワークフローファイルは 256KB 以下にしてください。', filename);
  if (!content.trim()) throw new GhError('ワークフローの内容を入力してください。', filename);
  fs.writeFileSync(file, content, 'utf8');
  return true;
}
function createLocalActionsWorkflow(cwd, { template, filename } = {}) {
  const item = ACTIONS_TEMPLATES[template];
  if (!item) throw new GhError('ワークフローのテンプレートを選んでください。', String(template));
  filename = String(filename || item.filename).trim();
  const file = actionsFile(cwd, filename, true);
  if (fs.existsSync(file)) throw new GhError('同じ名前のワークフローファイルがすでにあります。', filename);
  fs.writeFileSync(file, item.content, { encoding: 'utf8', flag: 'wx' });
  return { filename };
}
function listActionsTemplates() { return Object.entries(ACTIONS_TEMPLATES).map(([id, t]) => ({ id, label: t.label, filename: t.filename })); }
async function listActionsWorkflows(cwd) {
  return json(['workflow', 'list', '--all', '--limit', '100', '--json', 'id,name,path,state'], { cwd });
}
async function listActionsRuns(cwd) {
  return json(['run', 'list', '--limit', '30', '--json', 'databaseId,workflowName,displayTitle,event,status,conclusion,createdAt,updatedAt,url,headBranch'], { cwd });
}
async function runActionsWorkflow(cwd, workflow, ref, inputs = {}) {
  workflow = String(workflow || '').trim(); ref = String(ref || '').trim();
  if (!workflow || workflow.startsWith('-') || workflow.length > 200 || /[\r\n\0]/.test(workflow)) throw new GhError('ワークフローの指定が正しくありません。', workflow);
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.startsWith('-') || ref.includes('..')) throw new GhError('実行する分岐名を確認してください。', ref);
  const args = ['workflow', 'run', workflow, '--ref', ref];
  for (const [key, value] of Object.entries(inputs || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) throw new GhError('入力項目名の形式が正しくありません。', key);
    args.push('--raw-field', `${key}=${String(value)}`);
  }
  await run(args, { cwd });
  return true;
}
async function setActionsWorkflowEnabled(cwd, id, enabled) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw new GhError('ワークフローの指定が正しくありません。', id);
  await run(['workflow', enabled ? 'enable' : 'disable', id], { cwd });
  return true;
}
async function getActionsRun(cwd, id) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw new GhError('実行の指定が正しくありません。', id);
  return json(['run', 'view', id, '--json', 'databaseId,workflowName,displayTitle,event,status,conclusion,createdAt,updatedAt,url,headBranch,jobs'], { cwd });
}
async function getActionsRunLog(cwd, id) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw new GhError('実行の指定が正しくありません。', id);
  const r = await run(['run', 'view', id, '--log'], { cwd });
  const max = 180000;
  return r.stdout.length > max ? `（ログが長いため末尾を表示しています）\n${r.stdout.slice(-max)}` : r.stdout;
}
async function cancelActionsRun(cwd, id) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw new GhError('実行の指定が正しくありません。', id);
  await run(['run', 'cancel', id], { cwd }); return true;
}
async function rerunActionsRun(cwd, id) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw new GhError('実行の指定が正しくありません。', id);
  await run(['run', 'rerun', id], { cwd }); return true;
}

/* ------------------------------ 受信箱（通知） ------------------------------ */
const NOTE_TYPES = { PullRequest: 'pr', Issue: 'issue' };
/** GitHub の通知（変更の提案・課題・コメント・メンションなど）。未読のものだけ、新しい順 */
async function myNotifications() {
  const r = await run(['api', 'notifications?per_page=50', '--jq',
    '.[] | {id: .id, unread: .unread, reason: .reason, title: .subject.title, type: .subject.type, apiUrl: .subject.url, repo: .repository.full_name, updatedAt: .updated_at}']);
  return jsonLines(r.stdout).filter((n) => n.unread !== false).map((n) => {
    const num = (String(n.apiUrl || '').match(/\/(?:pulls|issues)\/(\d+)$/) || [])[1];
    const kind = NOTE_TYPES[n.type] || 'other';
    const base = `https://github.com/${n.repo}`;
    return { id: String(n.id), kind, reason: n.reason || '', title: n.title || '', repo: n.repo || '', number: num ? Number(num) : null, updatedAt: n.updatedAt,
      url: num && kind === 'pr' ? `${base}/pull/${num}` : num && kind === 'issue' ? `${base}/issues/${num}` : base };
  });
}
async function markNotificationRead(id) {
  if (!/^\d+$/.test(String(id))) throw new GhError('通知の指定が正しくありません。', String(id));
  await run(['api', '-X', 'PATCH', `notifications/threads/${id}`]);
  return true;
}
async function markAllNotificationsRead() { await run(['api', '-X', 'PUT', 'notifications']); return true; }

module.exports = {
  GhError, friendly, available, installPlan, installCli, extendPath, authStatus, switchAccount, ensureGitCredentials, myNotifications, markNotificationRead, markAllNotificationsRead, refreshGitCredentials, loginWithToken, loginWeb, cancelLogin, logout,
  listRepos, createRepo, setRepoVisibility, currentRepo, commitAuthorAvatar, listMembers, listSentInvites, inviteMember, cancelSentInvite, removeMember, myInvites, acceptInvite, declineInvite, checkAccess, myLogin, myProfile,
  listReleases, createRelease,
  listActionsTemplates, listLocalActionsWorkflows, readLocalActionsWorkflow, saveLocalActionsWorkflow, createLocalActionsWorkflow,
  listActionsWorkflows, listActionsRuns, runActionsWorkflow, setActionsWorkflowEnabled, getActionsRun, getActionsRunLog, cancelActionsRun, rerunActionsRun,
  listPRs, viewPR, diffPR, findPRForBranch, createPR, mergePR, closePR, reopenPR, checkoutPR, commentPR, updatePRBranch, requestPRReview, reviewPR,
  listIssues, listTasks, setTaskStatus, assignTaskToMe, createTask, editTask, viewIssue, createIssue, closeIssue, reopenIssue, deleteIssue, commentIssue,
  forumList, forumCreate, forumComment,
};
