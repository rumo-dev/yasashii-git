'use strict';
/* アプリ本体：状態管理・画面切り替え・上部バー・はじめの画面 */

const S = { repo: null, repoName: '', status: null, view: 'changes', settings: {}, recent: [], sig: '', auth: null, hasRemote: false, invites: [], inviteCount: 0 };

const G = (fn, ...a) => api.call('git', fn, S.repo, ...a);
const GH = (fn, ...a) => api.call('gh', fn, ...a);
const APP = (fn, ...a) => api.call('app', fn, ...a);

const NAV = [
  { id: 'changes', ico: '✏️', label: '変更' },
  { id: 'history', ico: '🕘', label: '履歴' },
  { id: 'branches', ico: '🌿', label: '作業の分岐', en: 'branch' },
  { id: 'stash', ico: '📦', label: '一時退避', en: 'stash' },
  { id: 'tags', ico: '🏷️', label: '目印', en: 'tag' },
  { id: 'tasks', ico: '📋', label: 'タスク' },
  { id: 'inbox', ico: '📬', label: '受信箱' },
  { id: 'team', ico: '👥', label: 'チーム' },
  { id: 'github', ico: '🐙', label: 'GitHub' },
  { id: 'forum', ico: '💬', label: 'バグ報告・要望' },
  { id: 'settings', ico: '⚙️', label: '設定' },
];

/* ------------------------------ 初期化 ------------------------------ */
async function init() {
  S.settings = await APP('getSettings');
  S.recent = S.settings.recent || [];
  S.version = await APP('version').catch(() => '');
  applySettings();
  api.onMenu(onMenu);
  api.onProgress((p) => busyProgress(p));
  Upd.init(); // 新しい版のお知らせ（ログイン前でも出す）
  startAuthWatch(); // ログインの有効期限切れを、操作していない間も見張る
  $('#glossaryBtn').onclick = showGlossary;
  $('#repoSwitch').onclick = repoSwitcher;
  window.addEventListener('focus', () => refreshStatus(true));
  setInterval(() => { if (S.repo && document.hasFocus() && !isBusy()) refreshStatus(true); }, 5000);
  setInterval(autoFetchTick, 30000);
  setInterval(() => { if (!isBusy()) inboxTick().catch(() => {}); }, 180000);   // 3分ごとに受信箱（招待・通知）を確認
  await requireLogin(); // GitHubにログインするまで先へ進めない
  await ensureGitUser(); // 名前・メールが未設定なら、GitHubアカウントから自動で入れる
  await startScreen();
}

async function startScreen() {
  refreshInboxCount().catch(() => {});
  refreshInviteCount().then((n) => { if (n) { toast(`📨 チームからの招待が ${n} 件届いています。「チーム」または「招待を確認」から参加できます。`); if (!S.repo && !document.querySelector('.overlay')) renderWelcome(); } });
  if (S.settings.lastRepo) {
    const r = await G_check(S.settings.lastRepo);
    if (r) return openRepo(S.settings.lastRepo, { silent: true });
  }
  renderWelcome();
}

/** ログアウト後などに、もう一度ログインを求めてから元の画面へ戻る */
async function relogin() {
  const was = S.repo;
  S.auth = null;
  await requireLogin();
  await ensureGitUser();
  if (was) await openRepo(was, { silent: true }); else renderWelcome();
}

/* ------------------------------ GitHub CLI のインストール案内 ------------------------------ */
/** gh（GitHub CLI）がないときの案内。クリックだけでインストールできる環境ではそのまま実行する。成功時 true */
async function installGhFlow({ askOnly = false } = {}) {
  let plan; try { plan = await GH('installPlan'); } catch (_) { plan = { method: 'manual', canAuto: false, label: 'ダウンロードページを開く', url: 'https://cli.github.com/' }; }
  const body = h('div', {},
    h('p', { style: { marginTop: 0 } }, 'GitHubとのやりとり（ログイン、プロジェクトの公開、変更の提案など）には、無料の「GitHub CLI」が必要です。'),
    h('p', { class: 'muted' }, 'まだインストールされていないようです。', plan.canAuto ? 'ボタンを押すだけで、自動でインストールできます（数分かかることがあります）。' : 'ダウンロードページからインストールしてください。インストール後、このアプリを開き直すと使えるようになります。'),
    plan.method === 'winget' ? h('p', { class: 'muted', style: { fontSize: '12px' } }, '※「このアプリがデバイスに変更を加えることを許可しますか？」と表示されたら「はい」を押してください。') : null,
    h('p', { class: 'muted', style: { fontSize: '12px' } }, 'GitHub CLIがなくても、Gitの基本操作（記録・履歴・作業の分岐など）は使えます。'));
  const buttons = [{ label: 'あとで', value: 'later' }];
  if (askOnly) buttons.push({ label: '今後は表示しない', value: 'never' });
  buttons.push({ label: plan.canAuto ? '⬇ ' + plan.label : '🌐 ' + plan.label, kind: 'primary', value: 'go' });
  const r = await modal({ title: '🐙 GitHub CLI をインストールしますか？', body, buttons });
  if (r === 'never') { await saveSettings({ ghPromptDismissed: true }); return false; }
  if (r !== 'go') return false;
  if (!plan.canAuto) { APP('openExternal', plan.url || 'https://cli.github.com/').catch(() => {}); return false; }
  const res = await withBusy('GitHub CLI をインストール中…（数分かかることがあります）', () => GH('installCli'));
  if (res === undefined) {
    const open = await confirmDialog({ title: '手動でインストールしますか？', message: 'ダウンロードページを開いて、手動でインストールすることもできます。', okLabel: 'ダウンロードページを開く' });
    if (open) APP('openExternal', 'https://cli.github.com/').catch(() => {});
    return false;
  }
  toast('GitHub CLI をインストールしました 🎉');
  if (S.view === 'github' && Views.github) go('github', true);
  return true;
}
/**
 * 記録に残す「名前」と「メール」が未設定なら、ログイン中のGitHubアカウントから自動で設定する。
 * すでに設定がある場合は何も変えない。成功（または設定済み）なら true、設定できなかったら false。
 * オフラインなどで取得できないときは、あとで「設定」画面から入力できるよう false を返すだけ（エラー表示はしない）。
 */
async function ensureGitUser({ notify = true } = {}) {
  let u;
  try { u = await api.call('git', 'getUser', S.repo || null); } catch (_) { return false; }
  if (u.name && u.email) return true;
  try {
    const p = await GH('myProfile');
    const r = await api.call('git', 'setUserIfMissing', S.repo || null, { name: p.name, email: p.email });
    if (notify && (r.applied.name || r.applied.email)) toast(`✨ GitHubアカウント「${p.login}」から、記録に残す名前とメールを自動で設定しました。（変更は「設定」画面でできます）`);
    return !!(r.name && r.email);
  } catch (_) { return false; }
}
/** 定期的な更新確認（設定でオンにしたときだけ）。失敗しても何も表示しない */
let autoFetchLast = 0, autoFetching = false;
async function autoFetchTick() {
  if (!S.settings.autoFetch || !S.repo || !S.hasRemote || !S.auth || autoFetching || isBusy()) return;
  const min = Math.max(1, Number(S.settings.autoFetchMin) || 5);
  if (Date.now() - autoFetchLast < min * 60000) return;
  autoFetching = true; autoFetchLast = Date.now();
  const repo = S.repo;
  try { await api.call('git', 'fetch', repo); if (S.repo === repo) await refreshStatus(true); }
  catch (_) { /* 通信できないときなどは黙って次回に回す */ }
  finally { autoFetching = false; }
}
const G_check = async (dir) => { try { const r = await api.call('git', 'checkRepo', dir); return r.isRepo ? r : null; } catch (_) { return null; } };

function applySettings() {
  settingsRef.showOriginal = S.settings.showOriginal !== false;
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
async function saveSettings(patch) { S.settings = await APP('setSettings', patch); applySettings(); buildNav(); updateChrome(); }

function onMenu(name) {
  if (name === 'update') { Upd.checkNow(); return; } // 更新の確認は、ログイン前でもできる
  if (!S.auth) return; // ログイン前は操作できない
  ({ open: openFolderFlow, init: initFlow, clone: cloneFlow, fetch: doFetch, sync: doSyncAll, pull: doPull, push: doPush, refresh: () => refreshStatus(false), glossary: showGlossary }[name] || (() => {}))();
}

/* ------------------------------ はじめの画面 ------------------------------ */
function showShell(on) { $('#sidebar').hidden = !on; $('#topbar').hidden = !on; if (!on) $('#hint').hidden = true; }

function renderWelcome() {
  S.repo = null; S.status = null; showShell(false);
  const v = clear($('#view'));
  const card = (ico, title, sub, fn) => h('button', { class: 'big-card', onclick: fn }, h('div', { class: 'ico' }, ico), h('b', {}, title), h('span', {}, sub));
  v.appendChild(h('div', { class: 'pad' },
    h('h2', {}, '🌱 やさしいGit へようこそ'),
    h('p', { class: 'sub' }, 'むずかしい用語を使わずに、ファイルの変更を記録・共有できるアプリです。まずは次のどれかを選んでください。'),
    h('div', { class: 'cards' },
      card('📂', 'フォルダを開く', jpEn('repository') + 'として、すでにあるフォルダを開きます', openFolderFlow),
      card('✨', '新しく作る', '空のフォルダから、変更を記録できるプロジェクトを作ります', initFlow),
      card('⬇️', 'ダウンロードして始める', '自分やチームのGitHubにあるプロジェクトを、一覧から選んでコピーします', () => cloneFlow()),
      card('💬', 'バグ報告・要望', 'やさしいGitについて、アプリ内から質問や改善案を投稿します', openForum),
      card('🔗', 'リンクで参加', 'チームの人から送られたリンクを貼り付けて、いっしょに作業を始めます', joinByLink),
      card('📨', '招待を確認', S.inviteCount ? `${S.inviteCount} 件の招待が届いています！` : 'チームから届いた招待に「参加する」で返事をします', invitesDialog)),
    h('div', { class: 'card' },
      h('h3', {}, '💡 基本の流れ（3ステップ）'),
      h('ol', { style: { margin: '4px 0 0', paddingLeft: '20px' } },
        h('li', {}, 'ファイルを編集する'),
        h('li', {}, h('b', {}, '「変更」画面'), 'で記録に含めるファイルを選び、メモを書いて', h('b', {}, '「変更を記録」')),
        h('li', {}, h('b', {}, '「アップロード」'), 'を押すだけ。初回は、GitHubへの登録も自動で行います（URLの入力は不要です）'))),
    S.recent.length ? h('div', {}, h('h3', {}, '最近使ったプロジェクト'),
      h('div', { class: 'list' }, S.recent.map((d) => h('div', { class: 'row clickable', onclick: () => openRepo(d) },
        h('span', {}, '📁'), h('div', { class: 'grow' }, h('div', { class: 'title' }, d.split(/[\\/]/).pop()), h('div', { class: 'muted', style: { fontSize: '12px' } }, d)),
        h('button', { class: 'btn small ghost', title: 'プロジェクトを削除', onclick: (e) => { e.stopPropagation(); removeProject(d); } }, '削除'))))) : null));
}

async function removeProject(dir, fromSwitcher = false) {
  const choice = await modal({ title: 'プロジェクトを削除', body: h('div', {},
    h('p', {}, `「${dir.split(/[\\/]/).pop()}」を一覧から削除します。`),
    h('p', { class: 'muted' }, '一覧から外すと、パソコン内のフォルダとファイルは残ります。フォルダごと削除すると、中のファイルもすべて削除されます。')),
    buttons: [
      { label: 'キャンセル', value: 'cancel' },
      { label: '一覧から外す（フォルダを残す）', value: 'remove' },
      { label: 'フォルダごと削除…', kind: 'danger', value: 'delete' },
    ] });
  if (!choice || choice === 'cancel') return;
  if (choice === 'delete') {
    const ok = await confirmDialog({ title: 'フォルダと中身を削除します', message: `次のフォルダをパソコンから完全に削除します。この操作は元に戻せません。\n\n${dir}`, okLabel: 'フォルダごと削除する' });
    if (!ok) return;
  }
  try {
    S.recent = await withBusyThrow(choice === 'delete' ? 'プロジェクトのフォルダを削除中…' : '一覧から外しています…', () => choice === 'delete' ? APP('deleteProject', dir) : APP('removeRecent', dir));
    if (S.repo && S.repo.toLowerCase() === dir.toLowerCase()) {
      S.repo = null; S.repoName = ''; S.status = null; S.hasRemote = false; S.sig = '';
      document.querySelector('.overlay')?.remove();
      renderWelcome();
    } else if (fromSwitcher) {
      document.querySelector('.overlay')?.remove();
      repoSwitcher();
    } else renderWelcome();
  } catch (e) { showError(e); }
}

async function openFolderFlow() {
  const dir = await APP('pickFolder', 'プロジェクトのフォルダを選んでください');
  if (dir) openRepo(dir);
}

async function initFlow() {
  const dir = await APP('pickFolder', '新しいプロジェクトにするフォルダを選んでください（新規作成もできます）');
  if (!dir) return;
  const chk = await api.call('git', 'checkRepo', dir);
  if (chk.isRepo) { toast('このフォルダはすでにプロジェクトです。開きます。'); return openRepo(dir); }
  const templates = await api.call('git', 'ignoreTemplates', dir);
  const setup = await formDialog({ title: '新しいプロジェクト', okLabel: '作成する', intro: '最初に使う .gitignore テンプレートを選べます。あとから「設定」でも追加できます。', fields: [
    { key: 'template', label: '.gitignore テンプレート', type: 'select', value: 'none', options: templates },
  ] });
  if (!setup) return;
  try {
    await withBusyThrow('プロジェクトを作成中…', async () => {
      await api.call('git', 'init', dir);
      if (setup.template !== 'none') await api.call('git', 'applyIgnoreTemplate', dir, setup.template);
    });
  } catch (e) { showError(e); return; }
  await openRepo(dir);
  toast('新しいプロジェクトを作りました 🎉');
}

/** GitHubのリンクや「ユーザー名/名前」から、{ owner, repo } を取り出す（/tree/… や /pull/… つきのリンク、SSH形式、.git つきもOK） */
function parseRepoRef(input) {
  const t = String(input || '').trim();
  let m = t.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:https?:\/\/)?(?:www\.)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\/?#].*)?$/i);
  if (!m) m = t.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
function normalizeRepoUrl(s) {
  const ref = parseRepoRef(s);
  return ref ? `https://github.com/${ref.owner}/${ref.repo}.git` : String(s || '').trim();
}

/** 自分のGitHubのプロジェクト一覧から選んでダウンロード（URLを直接入力することもできる） */
async function pickRepoToClone() {
  let list = [];
  try { list = await withBusy('GitHubのプロジェクト一覧を読み込み中…', () => GH('listRepos')) || []; } catch (_) { list = []; }
  let picked = null;
  const filter = h('input', { type: 'search', placeholder: '🔍 名前で絞り込む' });
  const listEl = h('div', { class: 'list', style: { maxHeight: '320px', overflow: 'auto', marginTop: '8px' } });
  const rows = new Map();
  let dlg;
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    clear(listEl);
    const shown = list.filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
    if (!shown.length) { listEl.appendChild(h('div', { class: 'empty' }, list.length ? '該当するプロジェクトがありません。' : 'GitHubにプロジェクトがまだありません。「リンクで参加」からも始められます。')); return; }
    shown.forEach((r) => {
      const row = h('div', { class: 'row clickable' + (picked && picked.nameWithOwner === r.nameWithOwner ? ' selected' : ''),
        onclick: () => { picked = r; draw(); },
        ondblclick: () => { picked = r; dlg && dlg.querySelector('footer .btn.primary').click(); } },
        h('span', {}, r.isPrivate ? '🔒' : '📖'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, r.nameWithOwner), (r.owner && S.auth && S.auth.login && r.owner.toLowerCase() !== S.auth.login.toLowerCase()) ? h('span', { class: 'pill blue', style: { marginLeft: '6px' } }, '👥 チーム・共有') : null, r.permission === 'read' ? h('span', { class: 'pill', style: { marginLeft: '6px' } }, '👀 見るだけ') : null), h('div', { class: 'muted title', style: { fontSize: '12px' } }, r.description || '（説明なし）')),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, relTime(r.updatedAt)));
      listEl.appendChild(row);
    });
  };
  filter.addEventListener('input', draw);
  draw();
  const r = await modal({
    title: '⬇️ ダウンロードして始める', wide: true,
    body: h('div', {}, h('p', { class: 'muted', style: { marginTop: 0 } }, '自分やチームのGitHubにあるプロジェクトを、手元のパソコンにコピーします。ダウンロードしたいものを選んでください。リンクだけを受け取っている場合は「リンクで参加」を使います。'), filter, listEl),
    buttons: [
      { label: 'キャンセル', value: undefined },
      { label: '🔗 リンクで参加…', value: 'url' },
      { label: 'ダウンロード', kind: 'primary', value: () => picked, validate: () => (picked ? null : 'ダウンロードするプロジェクトを選んでください。') },
    ],
    onOpen: (m) => { dlg = m; },
  });
  if (r === 'url') return resolveLink();
  return r ? r.nameWithOwner : null;
}

async function cloneFlow(prefill) {
  const target = typeof prefill === 'string' ? prefill : await pickRepoToClone();
  if (!target) return;
  const url = normalizeRepoUrl(target);
  const parent = await APP('pickFolder', 'ダウンロード先のフォルダを選んでください（この中にプロジェクトのフォルダが作られます）', S.settings.cloneParent);
  if (!parent) return;
  saveSettings({ cloneParent: parent }).catch(() => {});
  const res = await withBusy('ダウンロード中…（サイズによっては時間がかかります）', () => api.call('git', 'clone', null, url, parent));
  if (res) { await openRepo(res.root); toast('ダウンロードが完了しました 🎉'); }
}

/* ------------------------------ プロジェクトを開く ------------------------------ */
async function openRepo(dir, { silent = false } = {}) {
  let chk;
  try { chk = await api.call('git', 'checkRepo', dir); } catch (e) { if (!silent) await showError(e); return renderWelcome(); }
  if (!chk.exists) { if (!silent) toast('フォルダが見つかりません。', 'error'); S.recent = await APP('removeRecent', dir); return renderWelcome(); }
  if (!chk.isRepo) {
    const ok = await confirmDialog({
      title: 'まだ変更を記録できる状態ではありません',
      message: `このフォルダは、まだ ${jpEn('repository')} として始められていません。\n\n${dir}\n\n新しく始めますか？（フォルダの中のファイルは変わりません）`,
      okLabel: '新しく始める',
    });
    if (!ok) return;
    await withBusy('プロジェクトを作成中…', () => api.call('git', 'init', dir));
    chk = await api.call('git', 'checkRepo', dir);
  }
  S.repo = chk.root; S.repoName = chk.root.split(/[\\/]/).pop();
  S.recent = await APP('addRecent', S.repo);
  S.sig = ''; S.status = null;
  showShell(true); buildNav();
  await refreshStatus(false);
  go('changes', true);
  checkSshRemote().catch(() => {});
}

/** SourceTree などで取得したフォルダの接続先がSSH形式（git@github.com:…）のとき、ログイン情報で使えるHTTPS形式への切り替えを提案する */
const sshToHttps = (u) => {
  const m = u.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}.git` : null;
};
async function checkSshRemote() {
  const repo = S.repo;
  if ((S.settings.sshAsked || []).includes(repo)) return;
  const targets = (await G('remotes')).filter((r) => sshToHttps(r.fetchUrl));
  if (!targets.length) return;
  await saveSettings({ sshAsked: [...(S.settings.sshAsked || []), repo] });
  const ok = await confirmDialog({
    title: '🔑 GitHubとのつなぎ方をそろえますか？',
    message: 'このフォルダは「SSH鍵」を使う形式でGitHubにつながっています。\n\nこのアプリでは、いまログインしているGitHubアカウントをそのまま使えるよう、「HTTPS」形式に切り替えるのがおすすめです。（フォルダの中身や履歴は変わりません。いつでも「設定」画面で戻せます）',
    okLabel: '切り替える' });
  if (!ok || S.repo !== repo) return;
  for (const r of targets) await G('setRemoteUrl', r.name, sshToHttps(r.fetchUrl));
  toast('GitHubとのつなぎ方を切り替えました ✓');
  await refreshAll();
}

async function repoSwitcher() {
  const body = h('div', {}, h('div', { class: 'list' }, S.recent.map((d) => h('div', { class: 'row clickable' + (d === S.repo ? ' selected' : ''), onclick: () => { document.querySelector('.overlay').remove(); openRepo(d); } },
    h('span', {}, '📁'), h('div', { class: 'grow' }, h('div', {}, d.split(/[\\/]/).pop()), h('div', { class: 'muted', style: { fontSize: '12px' } }, d)),
    h('button', { class: 'btn small ghost', title: 'プロジェクトを削除', onclick: (e) => { e.stopPropagation(); removeProject(d, true); } }, '削除')))));
  const r = await modal({ title: 'プロジェクトを切り替える', body, buttons: [{ label: '閉じる', value: 'x' }, { label: '📂 フォルダを開く', value: 'open' }, { label: '✨ 新しく作る', value: 'init' }, { label: '⬇️ ダウンロード', value: 'clone' }] });
  if (r === 'open') openFolderFlow(); else if (r === 'init') initFlow(); else if (r === 'clone') cloneFlow();
}

/* ------------------------------ 状態更新 ------------------------------ */
async function refreshStatus(quiet) {
  if (!S.repo) return;
  let st;
  let hasRemote = S.hasRemote;
  try { st = await G('status'); hasRemote = (await G('remotes')).length > 0; }
  catch (e) { if (!quiet) await showError(e); return; }
  S.hasRemote = hasRemote;
  const sig = JSON.stringify([st.branch, st.oid, st.upstream, st.ahead, st.behind, st.operation, hasRemote, st.files.map((f) => [f.path, f.x, f.y])]);
  const changed = sig !== S.sig;
  S.status = st; S.sig = sig;
  if (changed || !quiet) {
    updateChrome();
    const v = Views[S.view];
    if (v && v.onStatus) v.onStatus(); else if (v && v.render && !quiet) go(S.view, true);
  }
}
const refreshAll = () => refreshStatus(false);

/* ------------------------------ 画面の枠 ------------------------------ */
function buildNav() {
  const nav = clear($('#nav'));
  NAV.forEach((n) => {
    nav.appendChild(h('button', { class: 'nav-item' + (S.view === n.id ? ' active' : ''), dataset: { id: n.id }, onclick: () => go(n.id) },
      h('span', { class: 'ico' }, n.ico), h('span', {}, n.label, n.en && settingsRef.showOriginal ? h('span', { class: 'en' }, n.en) : null), h('span', { class: 'count', hidden: true })));
    if (n.id === 'branches') nav.appendChild(h('div', { id: 'sideBranches', class: 'side-tree' })); // 左のメニューにも、分岐の一覧を出す
  });
}

/* ------------------------------ 左のメニューの分岐の一覧 ------------------------------ */
const sideOpen = { local: true, remote: false };   // 折りたたみの状態（手元は開く／サーバーは閉じる）
let sideToken = 0;
async function refreshSideBranches() {
  const box = document.getElementById('sideBranches');
  if (!box || !S.repo) return;
  const my = ++sideToken;
  let d; try { d = await G('branches'); } catch (_) { return; }
  if (my !== sideToken) return;
  clear(box);
  const group = (key, title, items, rowFn) => {
    const list = h('div', { class: 'side-list', hidden: !sideOpen[key] }, items.length ? items.map(rowFn) : h('div', { class: 'side-empty' }, 'ありません'));
    const arrow = h('span', { class: 'fold-arrow' }, sideOpen[key] ? '▼' : '▶');
    const head = h('button', { class: 'side-head', 'aria-expanded': String(sideOpen[key]), onclick: () => {
      sideOpen[key] = !sideOpen[key]; list.hidden = !sideOpen[key]; arrow.textContent = sideOpen[key] ? '▼' : '▶'; head.setAttribute('aria-expanded', String(sideOpen[key]));
    } }, arrow, h('span', { class: 'grow' }, title), h('span', { class: 'count' }, String(items.length)));
    box.append(head, list);
  };
  group('local', '手元の分岐', d.local, (b) => h('button', { class: 'side-row' + (b.current ? ' current' : ''), dataset: { branch: b.name }, title: b.current ? `${b.name}（今ここで作業中）` : `${b.name}\nクリックで切り替え`,
    onclick: () => (b.current ? go('branches') : switchFromSide(b.name)) },
    h('span', {}, b.current ? '📍' : '🌿'), h('span', { class: 'grow' }, b.name), b.ahead ? h('span', { class: 'mini' }, '↑' + b.ahead) : null, b.behind ? h('span', { class: 'mini' }, '↓' + b.behind) : null));
  group('remote', 'サーバー上の分岐', d.remote, (b) => h('button', { class: 'side-row', dataset: { branch: b.name }, title: `${b.name}\nクリックで「作業の分岐」画面を開く`, onclick: () => go('branches') },
    h('span', {}, '☁️'), h('span', { class: 'grow' }, b.name)));
}
async function switchFromSide(name) {
  const ok = await withBusy('切り替え中…', () => G('switchBranch', name));
  if (ok) { toast(`「${name}」に切り替えました`); await refreshAll(); }
}

function updateChrome() {
  const st = S.status; if (!st) return;
  refreshSideBranches();
  const rs = $('#repoSwitch'); clear(rs).append(h('small', {}, jp('repository')), h('b', {}, S.repoName));
  rs.title = S.repo;
  // 件数
  const changed = new Set(st.files.map((f) => f.path)).size;
  const c = $('.nav-item[data-id=changes] .count');
  if (c) { c.hidden = !changed; c.textContent = changed; }
  const ic = $('.nav-item[data-id=inbox] .count');
  if (ic) { ic.hidden = !S.inboxCount; ic.textContent = S.inboxCount || 0; }
  const tc = $('.nav-item[data-id=team] .count');
  if (tc) { tc.hidden = !S.inviteCount; tc.textContent = S.inviteCount; }
  // 上部バー
  const bar = clear($('#topbar'));
  const branchLabel = st.detached ? jp('detached') : (st.branch || '（まだ記録がありません）');
  [
    h('button', { class: 'branch-chip' + (st.detached ? ' detached' : ''), title: '作業の分岐を切り替える', onclick: () => go('branches') }, '🌿', h('span', {}, branchLabel), ' ▾'),
    st.upstream ? h('span', { class: 'muted', title: jp('upstream') }, '⇄ ' + st.upstream) : null,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn', id: 'syncAllBtn', title: 'サーバーの更新を確認して、新しいものがあれば取り込み、受信箱（招待・お知らせ）も確認します', onclick: doSyncAll }, '🔃 まとめて更新'),
    h('button', { class: 'btn', title: hint('fetch'), onclick: doFetch }, '🔄 ', termLabel('fetch')),
    h('button', { class: 'btn' + (st.behind ? ' primary' : ''), disabled: !st.behind, title: st.behind ? hint('pull') : '取り込む更新はありません', onclick: doPull }, '⬇️ ', termLabel('pull'), h('span', { class: 'badge' }, '↓' + (st.behind || 0))),
    h('button', { class: 'btn' + (st.ahead ? ' primary' : ''), disabled: !st.ahead, title: st.ahead ? hint('push') : 'アップロードする記録はありません', onclick: doPush }, '⬆️ ', termLabel('push'), h('span', { class: 'badge' }, '↑' + (st.ahead || 0))),
    h('button', { class: 'btn ghost', title: 'エクスプローラー / Finder でフォルダを開く', onclick: () => APP('openFolder', S.repo) }, '📂'),
  ].filter(Boolean).forEach((el) => bar.appendChild(el));
  // ヒント
  const hnt = $('#hint');
  const conflicts = st.files.filter((f) => f.conflict).length;
  const staged = st.files.filter((f) => f.staged).length;
  const unstaged = st.files.filter((f) => f.unstaged && !f.conflict).length;
  let msg = ''; let kind = '';
  if (st.operation && conflicts) { msg = `🧩 ${jp('conflict')}が ${conflicts} 件あります。「変更」画面で、どちらを採用するか選んでください。`; kind = 'danger'; }
  else if (st.operation) { msg = '✅ ぶつかりは解決しました。「変更」画面で完了ボタンを押してください。'; kind = 'warn'; }
  else if (st.detached) { msg = `⚠ いま${jp('detached')}です。作業を続けるには「作業の分岐」画面で分岐に戻ってください。`; kind = 'warn'; }
  else if (staged) { msg = `📝 ${staged} 個のファイルを記録する準備ができています。メモを書いて「${jp('commit')}」を押しましょう。`; kind = ''; }
  else if (unstaged) { msg = `✏️ ${unstaged} 個のファイルが変更されています。記録したいファイルにチェックを入れましょう。`; kind = ''; }
  else if (st.behind) { msg = `⬇️ サーバーに ${st.behind} 件の新しい更新があります。「${jp('pull')}」で取り込みましょう。`; kind = 'warn'; }
  else if (!S.hasRemote && st.hasCommits) { msg = '☁️ まだGitHubにありません。「アップロード」を押すと、GitHubに自動で作成して送ります。'; kind = 'ok'; }
  else if (st.ahead) { msg = `⬆️ ${st.ahead} 件の記録がまだ共有されていません。「${jp('push')}」で送りましょう。`; kind = 'ok'; }
  else if (!st.hasCommits) { msg = '🌱 まだ何も記録されていません。ファイルを追加して、最初の記録を作りましょう。'; }
  else { msg = '✨ すべて最新です。変更はありません。'; kind = 'ok'; }
  hnt.hidden = false; hnt.className = kind; hnt.textContent = msg;
}

function go(id, force) {
  if (!S.repo && id !== 'forum') return;
  if (S.view === id && !force) { const v = Views[id]; if (v && v.onStatus) return; }
  S.view = id;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  const container = clear($('#view'));
  container.scrollTop = 0;
  const v = Views[id];
  if (v) v.render(container);
}

function openForum() {
  if (S.repo) return go('forum');
  showShell(false);
  S.view = 'forum';
  Views.forum.render(clear($('#view')));
}

/* ------------------------------ 共通操作 ------------------------------ */
async function afterConflictCheck(res, okMsg) {
  await refreshAll();
  if (res && res.conflict) { toast(`${jp('conflict')}が見つかりました。「変更」画面で解決しましょう。`, 'error'); go('changes', true); return true; }
  if (okMsg) toast(okMsg);
  return false;
}

const NO_REMOTE_MSG = 'まだGitHubとつながっていません。「アップロード」を押すと、GitHubに自動で作成してつなぎます。';

async function doFetch() {
  if (!S.repo) return;
  if (!S.hasRemote) return toast(NO_REMOTE_MSG);
  const ok = await withBusy('サーバーの更新を確認中…', () => G('fetch'));
  await refreshAll();
  if (ok) toast('確認しました ✓');
}
/** まとめて更新：①サーバーの更新を確認 → ②新しいものがあれば取り込む → ③受信箱（招待・お知らせ）を確認。1ボタンで順に行う */
async function doSyncAll() {
  if (isBusy()) return;
  const notes = [];
  if (S.repo && S.hasRemote) {
    const ok = await withBusy('サーバーの更新を確認中…', () => G('fetch'));
    if (ok) {
      await refreshStatus(true);
      if (S.status && S.status.behind && !S.status.operation) {
        const { r } = await pullWithFallback();
        if (r === undefined) { await refreshAll(); return; }
        if (await afterConflictCheck(r, null)) return; // ぶつかりが出たら、解決してからもう一度
        notes.push('最新を取り込みました');
      } else if (S.status && S.status.behind) notes.push('取り込みの途中のため、取り込みはしていません');
      else notes.push('プロジェクトは最新です');
    }
  }
  const n = await withBusy('受信箱を確認中…', () => refreshInboxCount());
  await refreshAll();
  if (S.view === 'inbox' && Views.inbox) go('inbox', true);
  notes.push(n ? `受信箱に ${n} 件あります` : '受信箱は空です');
  toast('✓ ' + notes.join(' ／ '));
}

/** 取り込み。履歴のつながりが別のとき（サーバー側に別の最初の記録があるなど）は、確認のうえ合流する */
async function pullWithFallback() {
  try { return { r: await withBusyThrow('最新を取り込み中…', () => G('pull')) }; }
  catch (e) {
    if (!/unrelated histories/i.test(e.detail || '')) { await showError(e); return { r: undefined }; }
    const ok = await confirmDialog({ title: '別々に始まった履歴を合流しますか？', message: 'GitHub側と手元で、履歴の出発点が別々です（GitHubで先にREADMEを作った場合などに起こります）。\n\n両方の内容を残して合流できます。合流しますか？', okLabel: '合流する' });
    if (!ok) return { r: undefined };
    return { r: await withBusy('合流中…', () => G('pull', { allowUnrelated: true })) };
  }
}

async function doPull() {
  if (!S.repo) return;
  if (!S.hasRemote) return toast(NO_REMOTE_MSG);
  const { r } = await pullWithFallback();
  if (r === undefined) return refreshAll();
  await afterConflictCheck(r, r.upToDate ? 'すでに最新です ✓' : '最新を取り込みました ✓');
}

/** アップロード。GitHubとまだつながっていなければ作成から、サーバー側に新しい更新があれば先に取り込んでから、自動で行う */
/* ------------------------------ アップロード前の安全チェック ------------------------------ */
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

/**
 * 送る前に、これから送る記録に「秘密情報」や「大きすぎるファイル」がないか確認する。
 * 問題がなければ（または確認できなかったときも）true。止めるときは false。
 * ※ チェックそのものが失敗しても、アップロードは止めない。
 */
async function safetyGate() {
  if (S.settings.safetyCheck === false) return true;
  const r = await withBusy('送る前の確認中…', async () => { try { return await G('safetyCheck'); } catch (_) { return null; } });
  if (!r || !r.findings.length) return true;

  const blocked = r.findings.some((f) => f.level === 'block');
  const danger = r.findings.some((f) => f.level === 'danger');
  const order = { block: 0, danger: 1, warn: 2 };
  const list = [...r.findings].sort((a, b) => order[a.level] - order[b.level]);
  const where = (f) => (f.kind === 'secret' ? `${f.path} の ${f.line} 行目` : f.kind === 'size' ? `${f.path}（${fmtBytes(f.size)}）` : f.path);
  const rows = list.map((f) => {
    const btn = (f.kind === 'file' || f.kind === 'size') ? h('button', { class: 'btn small', title: '今後、このファイルを記録の対象から外します', onclick: async (e) => {
      const b = e.currentTarget;
      const ok = await G('addIgnore', '/' + f.path).then(() => true).catch((err) => { showError(err); return false; });
      if (ok) { b.textContent = '追加しました ✓'; b.disabled = true; }
    } }, '🚫 管理しない一覧に追加') : null;
    return h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      h('span', { class: 'pill ' + (f.level === 'warn' ? 'yellow' : 'red'), style: { marginTop: '2px' } }, f.level === 'block' ? '送れません' : f.level === 'danger' ? '要注意' : '念のため'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, f.label)), h('div', { class: 'mono muted', style: { fontSize: '12px', wordBreak: 'break-all' } }, where(f)), f.why ? h('div', { class: 'muted', style: { fontSize: '12px' } }, f.why) : null),
      btn);
  });
  const body = h('div', {},
    h('p', { style: { marginTop: 0 } }, `これから送る記録（${r.commits}件）に、次のものが含まれています。`),
    h('div', { class: 'list', style: { maxHeight: '240px', overflow: 'auto', marginBottom: '10px' } }, rows),
    danger ? h('p', { class: 'danger-note' }, '⚠ GitHubに送ると、プロジェクトに参加する人の全員に見えます（「公開」にしている場合は、世界中の人に）。一度送ると、あとでファイルを消しても「履歴」に残ります。') : null,
    blocked ? h('p', { class: 'danger-note' }, '⛔ 100MBを超えるファイルは、GitHubに送れません。（50MB〜100MBのファイルは、送れますが警告が出ます）') : null,
    !danger && !blocked ? h('p', { class: 'muted' }, '念のための確認です。問題がなければ「それでも送る」を押してください。') : null,
    (danger || blocked) ? h('div', { class: 'muted', style: { fontSize: '13px' } }, h('b', {}, '直し方'),
      h('ol', { style: { margin: '4px 0 0', paddingLeft: '20px' } },
        h('li', {}, '「やめる」を押します。'),
        h('li', {}, '「変更」画面の「↩ 直前の記録を取り消す」を押します。（問題のファイルが複数の記録に入っているときは、くり返します）'),
        h('li', {}, '問題のファイルを「記録に含めるファイル」から外してから、もう一度記録します。（上の「🚫 管理しない一覧に追加」を押しておくと、今後は対象外になります）'))) : null,
    r.contentSkipped ? h('p', { class: 'muted', style: { fontSize: '12px' } }, '※ 送る量が多いため、ファイルの中身（パスワードなど）のチェックは省略しました。ファイル名と大きさだけ確認しています。') : null,
    h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: 0 } }, 'この確認は「設定」画面でオフにできます。'));
  const buttons = [{ label: 'やめる', kind: 'primary', value: false }];
  if (!blocked) buttons.push({ label: 'それでも送る', kind: danger ? 'danger-solid' : undefined, value: true });
  const ans = await modal({ title: blocked ? '⛔ このままでは送れません' : danger ? '⚠ 送る前に確認してください' : '🔎 送る前の確認', body, buttons, wide: true });
  if (ans === true) return true;
  toast('アップロードを中止しました。');
  return false;
}

async function doPush() {
  if (!S.repo) return false;
  await refreshStatus(true);
  if (!S.status.hasCommits && !S.hasRemote) { toast('まだ記録がありません。先に「変更を記録」してください。', 'error'); return false; }
  if (S.status.hasCommits && !(await safetyGate())) return false; // 秘密情報・大きなファイルの確認
  if (!S.hasRemote) return publishToGitHub({ thenPush: true });
  const st = await withBusy('サーバーの状態を確認中…', () => G('prepareSync'));
  if (st === undefined) return false;
  if (!st.hasCommits) { // 記録がまだ無い：サーバーの内容を取り込むだけ
    const { r } = await pullWithFallback(); await refreshAll();
    if (r && !r.conflict) toast('サーバーの内容を取り込みました ✓');
    return false;
  }
  if (st.behind) {
    const { r } = await pullWithFallback();
    if (r === undefined) { await refreshAll(); return false; }
    if (await afterConflictCheck(r, null)) return false; // ぶつかりが出たら、解決してからもう一度
  }
  let ok;
  try { ok = await withBusyThrow('アップロード中…', () => G('push')); }
  catch (e) {
    if (isCancelError(e)) ok = undefined;
    else if (!(await offerPendingInvite(e))) await showError(e);
    ok = undefined;
  }
  await refreshAll();
  if (ok) toast(st.behind ? '最新を取り込んでから、アップロードしました 🎉' : 'アップロードしました 🎉');
  return !!ok;
}

/** アップロードが権限で失敗したとき、まだ承諾していない招待があれば、その場で参加できるようにする。案内を出したら true */
async function offerPendingInvite(e) {
  if (!/権限|認証|ログイン|見つか|403|404|denied|Permission|not found/i.test((e.message || '') + (e.detail || ''))) return false;
  let list = []; try { list = await GH('myInvites'); } catch (_) { return false; }
  if (!list.length) return false;
  const remotes = await G('remotes').catch(() => []);
  const urls = remotes.map((r) => String(r.pushUrl || r.fetchUrl || '').toLowerCase());
  const hit = list.find((i) => urls.some((u) => u.includes('/' + i.repo.toLowerCase())));
  if (!hit) return false;
  const ok = await confirmDialog({ title: '📨 まだ招待に参加していません', message: `「${hit.repo}」への招待が ${hit.inviter} さんから届いていますが、まだ「参加する」を押していません。\nそのため、アップロードが許可されませんでした。\n\n今ここで参加して、もう一度アップロードしますか？`, okLabel: '参加する' });
  if (!ok) return true;
  if (await withBusy('参加しています…', () => GH('acceptInvite', hit.id))) { toast('参加しました 🎉'); refreshInviteCount(); doPush(); }
  return true;
}

/** GitHubの名前に使える形に整える（日本語などは使えないため） */
function ghSafeName(name) {
  const n = String(name || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.-]+/, '').slice(0, 80);
  return n || 'my-project';
}

/** このプロジェクトをGitHubに新しく作って結びつける。thenPush: そのままアップロードまで行う */
async function publishToGitHub({ thenPush = false } = {}) {
  const safe = ghSafeName(S.repoName);
  const r = await formDialog({
    title: '☁️ GitHubにアップロードする準備',
    okLabel: thenPush ? '作成してアップロード' : '作成する',
    intro: 'このプロジェクトは、まだGitHubにありません。GitHub上に新しく作って、自動でつなぎます。URLの入力は要りません。',
    fields: [
      { key: 'name', label: 'GitHub上の名前', value: safe, required: true, help: safe !== S.repoName.trim() ? 'GitHubの名前には英数字と - _ . が使えます。日本語は使えないため、自動で変換しています。' : '半角の英数字と - _ . が使えます。' },
      { key: 'isPrivate', label: '自分だけが見られる「非公開」にする', type: 'checkbox', value: true, help: 'チェックを外すと、誰でも見られる「公開」になります。あとから変更もできます。' }] });
  if (!r) return false;
  const name = ghSafeName(r.name);
  const made = await withBusy('GitHubに作成中…', () => GH('createRepo', S.repo, { name, isPrivate: r.isPrivate }));
  if (!made) return false;
  S.hasRemote = true;
  if (!thenPush) { await refreshAll(); toast('GitHubに作成しました 🎉'); return true; }
  // 新規作成直後は現在のブランチを origin に明示して初回 push し、追跡先を正しく結びつける。
  const ok = await withBusy('アップロード中…', () => G('push', { setUpstream: true }));
  await refreshAll();
  if (ok) { toast('GitHubに作成して、アップロードしました 🎉'); return true; }
  return false;
}

function showGlossary() {
  const rows = Object.values(TERMS).map((t) => h('tr', {}, h('td', {}, h('b', {}, t.ja)), h('td', { class: 'mono' }, t.en), h('td', { class: 'muted' }, t.hint)));
  modal({ title: '📖 用語の対応表', wide: true, body: h('div', {}, h('p', { class: 'sub' }, 'このアプリで使っているやさしい言い方と、元のGit用語の対応です。他の資料やチームの会話で元の用語が出てきたときに使ってください。'),
    h('table', { class: 'glossary' }, h('tr', {}, h('th', {}, 'このアプリでは'), h('th', {}, 'Git用語'), h('th', {}, '意味')), rows)), buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
}

document.addEventListener('DOMContentLoaded', () => init().catch((e) => { console.error(e); showError(e); }));
