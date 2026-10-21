'use strict';
/* 「GitHub」画面：ログイン・リポジトリ・変更の提案（PR）・課題（Issue） */
Views.github = (() => {
  let root, tab = 'account', auth = null, body, prState = 'open', issueState = 'open';

  function render(container) { root = container; auth = null; draw(); }
  function onStatus() {}

  const TABS = [['account', '👤 アカウント'], ['repos', '📚 リポジトリ'], ['prs', '🔀 変更の提案'], ['issues', '💬 課題・相談'], ['releases', '🚀 リリース']];

  async function draw() {
    body = h('div', {});
    clear(root).appendChild(h('div', { class: 'pad' },
      h('h2', {}, '🐙 GitHub'),
      h('p', { class: 'sub' }, 'GitHubのアカウント、リポジトリ、チームとのやりとりを確認できます。'),
      h('div', { class: 'tabs' }, TABS.map(([id, label]) => h('button', { class: 'tab' + (tab === id ? ' active' : ''), onclick: () => { tab = id; draw(); } },
        label, id === 'prs' ? h('span', { class: 'en' }, 'PR') : id === 'issues' ? h('span', { class: 'en' }, 'Issue') : null))),
      body));
    body.appendChild(h('div', { class: 'empty' }, '確認中…'));
    if (!auth) { try { auth = await GH('authStatus'); } catch (e) { auth = { installed: false, message: e.message }; } }
    if (!root.isConnected) return;
    clear(body);
    if (!auth.installed) return body.appendChild(notInstalled());
    if (tab === 'account') return account();
    if (!auth.loggedIn) { relogin(); return; }
    if (tab === 'repos') return repos();
    if (tab === 'prs') return prs();
    if (tab === 'issues') return issues();
    if (tab === 'releases') return releases();
  }

  function notInstalled() {
    return h('div', { class: 'card' }, h('h3', {}, 'GitHub CLI（gh）が見つかりません'),
      h('p', {}, 'GitHubとの連携には、無料の「GitHub CLI」が必要です。'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: async () => { if (await installGhFlow()) { auth = null; draw(); } } }, '⬇ インストールする'),
        h('button', { class: 'btn', onclick: () => APP('openExternal', 'https://cli.github.com/') }, 'ダウンロードページを開く'),
        h('button', { class: 'btn', onclick: () => { auth = null; draw(); } }, '🔄 もう一度確認')));
  }

  /* ---------------- アカウント ---------------- */
  function account() {
    body.appendChild(h('div', { class: 'card' }, h('h3', {}, '✅ ログイン済み'),
      h('p', {}, auth.login ? 'GitHubアカウント：' : 'ログインしています。', auth.login ? h('b', {}, auth.login) : null),
      h('p', { class: 'muted' }, S.hasRemote ? 'このプロジェクトは、GitHubとつながっています。「アップロード」ボタンで記録を送れます。' : 'このプロジェクトは、まだGitHubにありません。「アップロード」を押すと自動で作成されます。'),
      h('div', { class: 'btn-row' },
        S.hasRemote ? null : h('button', { class: 'btn primary', onclick: async () => { if (await publishToGitHub({ thenPush: true })) draw(); } }, '☁️ GitHubに作成してアップロード'),
        h('button', { class: 'btn danger', onclick: logout }, 'ログアウト'))));
  }

  async function logout() {
    const ok = await confirmDialog({ title: 'ログアウトしますか？', message: 'ログアウトすると、もう一度ログインするまでアプリを使えません。', okLabel: 'ログアウト', danger: true });
    if (!ok) return;
    const r = await withBusy('処理中…', () => GH('logout'));
    if (r) relogin();
  }

  /* ---------------- リポジトリ ---------------- */
  async function repos() {
    body.appendChild(h('div', { class: 'empty' }, '読み込み中…'));
    let list;
    try { list = await GH('listRepos'); } catch (e) { clear(body).appendChild(h('div', { class: 'card' }, e.message)); return; }
    clear(body).appendChild(h('div', { class: 'list' }, list.length ? list.map((r) => h('div', { class: 'row' },
      h('span', {}, r.isPrivate ? '🔒' : '📖'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, r.nameWithOwner), ' ', r.isFork ? h('span', { class: 'pill' }, 'フォーク') : null), h('div', { class: 'muted title', style: { fontSize: '12px' } }, r.description || '（説明なし）')),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, relTime(r.updatedAt)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', onclick: () => cloneFlow(r.nameWithOwner) }, '⬇ ダウンロード'), h('button', { class: 'btn small', onclick: () => APP('openExternal', r.url) }, 'ブラウザで開く')))) : h('div', { class: 'empty' }, 'リポジトリがありません。')));
  }

  /* ---------------- 変更の提案（PR） ---------------- */
  const stateSel = (cur, set) => h('select', { style: { width: 'auto' }, onchange: (e) => set(e.target.value) },
    [['open', '受付中'], ['merged', '取り込み済み'], ['closed', '閉じた'], ['all', 'すべて']].map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));

  async function prs() {
    const st = S.status;
    const bar = h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
      stateSel(prState, (v) => { prState = v; draw(); }),
      h('button', { class: 'btn primary', onclick: createPR }, '＋ 変更の提案を作る'));
    body.appendChild(bar); body.appendChild(h('p', { class: 'sub' }, hint('pr')));
    const listEl = h('div', {}, h('div', { class: 'empty' }, '読み込み中…')); body.appendChild(listEl);
    let list;
    try { list = await GH('listPRs', S.repo, prState); } catch (e) { clear(listEl).appendChild(h('div', { class: 'card' }, e.message)); return; }
    clear(listEl).appendChild(h('div', { class: 'list' }, list.length ? list.map((p) => h('div', { class: 'row' },
      h('span', {}, p.state === 'MERGED' ? '🟣' : p.state === 'CLOSED' ? '🔴' : '🟢'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, `#${p.number} ${p.title}`), p.isDraft ? h('span', { class: 'pill yellow', style: { marginLeft: '6px' } }, '下書き') : null),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `${p.headRefName} → ${p.baseRefName}　👤 ${p.author ? p.author.login : ''}　${relTime(p.createdAt)}`)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => APP('openExternal', p.url) }, 'ブラウザで開く'),
        p.state === 'OPEN' ? [h('button', { class: 'btn small', onclick: () => checkoutPR(p) }, '手元に持ってくる'),
          h('button', { class: 'btn small primary', onclick: () => mergePR(p) }, '取り込む（合流）'),
          h('button', { class: 'btn small danger', onclick: () => closePR(p) }, '閉じる')] : null))) : h('div', { class: 'empty' }, '該当する変更の提案はありません。')));
  }
  async function createPR() {
    const st = S.status;
    if (!st.branch) { toast('作業の分岐の上で実行してください', 'error'); return; }
    let branches; try { branches = (await G('branches')).local.map((b) => b.name); } catch (_) { branches = ['main']; }
    const base = ['main', 'master', 'develop'].find((b) => branches.includes(b) && b !== st.branch) || branches.find((b) => b !== st.branch) || 'main';
    const r = await formDialog({ title: '変更の提案を作る', okLabel: '提案する',
      intro: `「${st.branch}」の作業内容を、別の分岐へ取り込んでもらうよう提案します。\n※先に「アップロード」して、GitHubに作業内容を送っておいてください。`,
      fields: [
        { key: 'title', label: 'タイトル', required: true, placeholder: '例：ログイン画面を追加' },
        { key: 'body', label: '説明（省略できます）', type: 'textarea', placeholder: '何を変えたか、確認してほしい点など' },
        { key: 'base', label: '取り込み先の分岐', type: 'select', value: base, options: branches.filter((b) => b !== st.branch).map((b) => ({ value: b, label: b })) },
        { key: 'draft', label: '下書きとして作る', type: 'checkbox', value: false, help: '準備中であることを示します。' }] });
    if (!r) return;
    const res = await withBusy('提案を作成中…', () => GH('createPR', S.repo, { title: r.title, body: r.body, base: r.base, head: st.branch, draft: r.draft }));
    if (res) { toast('変更の提案を作りました 🎉'); if (res.url) APP('openExternal', res.url).catch(() => {}); draw(); }
  }
  async function mergePR(p) {
    const r = await formDialog({ title: `#${p.number} を取り込みますか？`, okLabel: '取り込む', danger: true, intro: `「${p.title}」を「${p.baseRefName}」に取り込みます。`,
      fields: [
        { key: 'method', label: '取り込み方', type: 'select', value: 'merge', options: [{ value: 'merge', label: 'そのまま合流する（おすすめ）' }, { value: 'squash', label: '1つの記録にまとめて合流する' }, { value: 'rebase', label: '履歴を一直線につなげて合流する' }] },
        { key: 'del', label: '取り込んだあと、元の分岐を削除する', type: 'checkbox', value: false }] });
    if (!r) return;
    const ok = await withBusy('取り込み中…', () => GH('mergePR', S.repo, p.number, r.method, r.del));
    if (ok) { toast('取り込みました ✓'); draw(); }
  }
  async function closePR(p) {
    if (!(await confirmDialog({ title: `#${p.number} を閉じますか？`, message: '取り込まずに閉じます。あとで開き直すこともできます。', okLabel: '閉じる', danger: true }))) return;
    if (await withBusy('処理中…', () => GH('closePR', S.repo, p.number))) { toast('閉じました'); draw(); }
  }
  async function checkoutPR(p) {
    const ok = await withBusy('手元に持ってきています…', () => GH('checkoutPR', S.repo, p.number));
    if (ok) { toast(`「${p.headRefName}」に切り替えました`); await refreshAll(); }
  }

  /* ---------------- リリース ---------------- */
  async function releases() {
    body.appendChild(h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn primary', onclick: async () => { if (await releaseFlow()) draw(); } }, '🚀 リリースを作る')));
    body.appendChild(h('p', { class: 'sub' }, 'バージョン名（目印）をつけて、リリースノートつきでGitHubに公開します。前のバージョンからの記録のメモが、リリースノートの下書きになります。'));
    const listEl = h('div', {}, h('div', { class: 'empty' }, '読み込み中…')); body.appendChild(listEl);
    if (!S.hasRemote) { clear(listEl).appendChild(h('div', { class: 'empty' }, 'このプロジェクトは、まだGitHubにありません。「アップロード」を押すと作成されます。')); return; }
    let list, info;
    try { [list, info] = await Promise.all([GH('listReleases', S.repo), GH('currentRepo', S.repo)]); } catch (e) { clear(listEl).appendChild(h('div', { class: 'card' }, e.message)); return; }
    clear(listEl).appendChild(h('div', { class: 'list' }, list.length ? list.map((x) => h('div', { class: 'row' },
      h('span', {}, '🚀'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, x.name || x.tagName), x.name && x.name !== x.tagName ? h('span', { class: 'muted', style: { marginLeft: '6px' } }, x.tagName) : null,
        x.isLatest ? h('span', { class: 'pill green', style: { marginLeft: '6px' } }, '最新') : null,
        x.isDraft ? h('span', { class: 'pill yellow', style: { marginLeft: '6px' } }, '下書き') : null,
        x.isPrerelease ? h('span', { class: 'pill blue', style: { marginLeft: '6px' } }, '先行版') : null),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, relTime(x.publishedAt || x.createdAt))),
      info && info.url ? h('button', { class: 'btn small', onclick: () => APP('openExternal', `${info.url}/releases/tag/${encodeURIComponent(x.tagName)}`) }, 'ブラウザで開く') : null))
      : h('div', { class: 'empty' }, 'まだリリースはありません。')));
  }

  /* ---------------- 課題・相談（Issue） ---------------- */
  async function issues() {
    body.appendChild(h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
      h('select', { style: { width: 'auto' }, onchange: (e) => { issueState = e.target.value; draw(); } }, [['open', '受付中'], ['closed', '完了'], ['all', 'すべて']].map(([v, l]) => h('option', { value: v, selected: v === issueState }, l))),
      h('button', { class: 'btn primary', onclick: createIssue }, '＋ 課題・相談を書く')));
    body.appendChild(h('p', { class: 'sub' }, hint('issue')));
    const listEl = h('div', {}, h('div', { class: 'empty' }, '読み込み中…')); body.appendChild(listEl);
    let list;
    try { list = await GH('listIssues', S.repo, issueState); } catch (e) { clear(listEl).appendChild(h('div', { class: 'card' }, e.message)); return; }
    clear(listEl).appendChild(h('div', { class: 'list' }, list.length ? list.map((i) => h('div', { class: 'row' },
      h('span', {}, i.state === 'OPEN' ? '🟢' : '✅'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, `#${i.number} ${i.title}`), (i.labels || []).map((l) => h('span', { class: 'pill blue', style: { marginLeft: '6px' } }, l.name))),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${i.author ? i.author.login : ''}　${relTime(i.createdAt)}　💬 ${(i.comments || []).length}`)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => APP('openExternal', i.url) }, 'ブラウザで開く'),
        h('button', { class: 'btn small', onclick: () => commentIssue(i) }, 'コメント'),
        i.state === 'OPEN' ? h('button', { class: 'btn small', onclick: () => setIssue(i, 'closeIssue', '完了にしました') }, '完了にする') : h('button', { class: 'btn small', onclick: () => setIssue(i, 'reopenIssue', '開き直しました') }, '開き直す')))) : h('div', { class: 'empty' }, '該当する課題・相談はありません。')));
  }
  async function createIssue() {
    const r = await formDialog({ title: '課題・相談を書く', okLabel: '投稿する', fields: [
      { key: 'title', label: 'タイトル', required: true, placeholder: '例：ログインできないことがある' },
      { key: 'body', label: '内容', type: 'textarea', rows: 6, placeholder: '状況、再現手順、期待する動きなど' }] });
    if (!r) return;
    const res = await withBusy('投稿中…', () => GH('createIssue', S.repo, r));
    if (res) { toast('投稿しました ✓'); draw(); }
  }
  async function commentIssue(i) {
    const r = await formDialog({ title: `#${i.number} にコメント`, okLabel: '送信する', fields: [{ key: 'body', label: 'コメント', type: 'textarea', rows: 5, required: true }] });
    if (!r) return;
    if (await withBusy('送信中…', () => GH('commentIssue', S.repo, i.number, r.body))) { toast('送信しました ✓'); draw(); }
  }
  async function setIssue(i, fn, msg) {
    if (await withBusy('処理中…', () => GH(fn, S.repo, i.number))) { toast(msg); draw(); }
  }

  return { render, onStatus };
})();
