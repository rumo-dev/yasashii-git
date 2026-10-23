'use strict';
/* 「GitHub」画面：ログイン・リポジトリ・変更の提案（PR）・課題（Issue） */
Views.github = (() => {
  let root, tab = 'account', auth = null, body, prState = 'open', issueState = 'open', repoQuery = '';

  function render(container) { root = container; auth = null; draw(); }
  function onStatus() {}

  const TABS = [['account', '👤 アカウント'], ['repos', '📚 リポジトリ'], ['prs', '🔀 変更の提案'], ['issues', '💬 課題・相談'], ['actions', '⚙️ Actions'], ['releases', '🚀 リリース']];

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
    if (tab === 'actions') return actions();
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
    if (!root.isConnected) return;
    clear(body);
    const filter = h('input', { type: 'search', class: 'input', placeholder: '🔍 リポジトリ名・所有者・説明で検索', value: repoQuery, style: { width: '100%', maxWidth: '460px', marginBottom: '12px' } });
    const listEl = h('div', {});
    const drawList = () => {
      repoQuery = filter.value;
      const query = repoQuery.trim().toLocaleLowerCase();
      const shown = list.filter((r) => !query || [r.nameWithOwner, r.owner, r.description].some((v) => String(v || '').toLocaleLowerCase().includes(query)));
      clear(listEl);
      if (!shown.length) {
        listEl.appendChild(h('div', { class: 'empty' }, list.length ? '検索条件に一致するリポジトリがありません。' : 'リポジトリがありません。'));
        return;
      }
      listEl.appendChild(h('div', { class: 'list' }, shown.map((r) => h('div', { class: 'row' },
        h('span', {}, r.isPrivate ? '🔒' : '📖'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, r.nameWithOwner), ' ', r.isFork ? h('span', { class: 'pill' }, 'フォーク') : null), h('div', { class: 'muted title', style: { fontSize: '12px' } }, r.description || '（説明なし）')),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, relTime(r.updatedAt)),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', onclick: () => cloneFlow(r.nameWithOwner) }, '⬇ ダウンロード'), h('button', { class: 'btn small', onclick: () => APP('openExternal', r.url) }, 'ブラウザで開く'))))));
    };
    filter.addEventListener('input', drawList);
    body.append(filter, listEl);
    drawList();
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

  /* ---------------- GitHub Actions ---------------- */
  async function actions() {
    const localEl = h('div', {}), remoteEl = h('div', {}), runsEl = h('div', {});
    body.appendChild(h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn primary', onclick: createActionsWorkflow }, '＋ ワークフローを作る'),
      S.hasRemote ? h('button', { class: 'btn', onclick: loadActions }, '🔄 更新') : null));
    body.appendChild(h('p', { class: 'sub' }, '自動テストやビルドなどを設定できます。ワークフローはプロジェクト内に作成し、アップロード後にGitHubで有効になります。'));
    body.appendChild(h('section', { class: 'card' }, h('h3', {}, 'このパソコンにあるワークフロー'),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, '作成・編集したファイルはローカルに保存されます。内容を確認してから「記録」してアップロードしてください。'), localEl));
    if (S.hasRemote) {
      body.appendChild(h('section', { class: 'card' }, h('h3', {}, 'GitHub上のワークフロー'), remoteEl));
      body.appendChild(h('section', { class: 'card' }, h('h3', {}, '最近の実行'), runsEl));
      remoteEl.appendChild(h('div', { class: 'empty' }, '読み込み中…'));
      runsEl.appendChild(h('div', { class: 'empty' }, '読み込み中…'));
    } else {
      body.appendChild(h('div', { class: 'card' }, 'このプロジェクトはGitHubとつながっていません。ワークフローを作成して記録・アップロードすると、GitHub Actionsを利用できます。'));
    }
    await loadActions();

    async function loadActions() {
      try {
        const local = await GH('listLocalActionsWorkflows', S.repo);
        clear(localEl);
        if (!local.length) localEl.appendChild(h('div', { class: 'empty' }, 'ワークフローはまだありません。テンプレートから作成できます。'));
        else localEl.appendChild(h('div', { class: 'list' }, local.map((f) => h('div', { class: 'row' },
          h('span', {}, '📄'), h('div', { class: 'grow mono' }, f.filename),
          h('span', { class: 'muted', style: { fontSize: '12px' } }, `${Math.ceil(f.size / 1024)} KB`),
          h('button', { class: 'btn small', onclick: () => editActionsWorkflow(f.filename) }, '編集')))));
      } catch (e) { clear(localEl).appendChild(h('div', { class: 'empty' }, e.message)); }
      if (!S.hasRemote || !root.isConnected) return;
      const [workflowsResult, runsResult] = await Promise.allSettled([GH('listActionsWorkflows', S.repo), GH('listActionsRuns', S.repo)]);
      clear(remoteEl);
      if (workflowsResult.status === 'rejected') remoteEl.appendChild(h('div', { class: 'empty' }, workflowsResult.reason.message));
      else {
        const workflows = workflowsResult.value || [];
        if (!workflows.length) remoteEl.appendChild(h('div', { class: 'empty' }, 'GitHub上にワークフローがありません。作成したファイルを記録してアップロードしてください。'));
        else remoteEl.appendChild(h('div', { class: 'list' }, workflows.map((w) => h('div', { class: 'row' },
          h('span', {}, w.state === 'active' ? '🟢' : '⏸️'),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, w.name), h('span', { class: 'muted mono', style: { marginLeft: '8px', fontSize: '11px' } }, w.path)),
            h('div', { class: 'muted', style: { fontSize: '12px' } }, w.state === 'active' ? '有効' : '一時停止中')),
          h('button', { class: 'btn small primary', disabled: w.state !== 'active', title: w.state !== 'active' ? '実行するには先に有効にしてください' : 'workflow_dispatch に対応した分岐で実行します', onclick: () => runActionsWorkflow(w) }, '▶ 手動実行'),
          h('button', { class: 'btn small', onclick: () => toggleActionsWorkflow(w) }, w.state === 'active' ? '一時停止' : '有効にする')))));
      }
      clear(runsEl);
      if (runsResult.status === 'rejected') runsEl.appendChild(h('div', { class: 'empty' }, runsResult.reason.message));
      else {
        const runs = runsResult.value || [];
        if (!runs.length) runsEl.appendChild(h('div', { class: 'empty' }, '実行履歴はありません。'));
        else runsEl.appendChild(h('div', { class: 'list' }, runs.map((r) => {
          const active = ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(r.status);
          const stateText = active ? (r.status === 'in_progress' ? '実行中' : '待機中') : r.conclusion === 'success' ? '成功' : r.conclusion === 'failure' ? '失敗' : r.conclusion === 'cancelled' ? 'キャンセル' : (r.conclusion || r.status || '完了');
          const stateClass = active ? 'pill blue' : r.conclusion === 'success' ? 'pill green' : r.conclusion === 'failure' ? 'pill red' : 'pill';
          return h('div', { class: 'row' }, h('span', {}, active ? '⏳' : r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : '⚪'),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, r.workflowName || 'ワークフロー'), ' ', h('span', { class: stateClass }, stateText)),
              h('div', { class: 'muted', style: { fontSize: '12px' } }, `#${r.databaseId}　${r.displayTitle || ''}　${r.headBranch || ''}　${relTime(r.createdAt)}`)),
            h('button', { class: 'btn small', onclick: () => showActionsRun(r) }, '詳細・ログ'),
            active ? h('button', { class: 'btn small danger', onclick: () => cancelActionsRun(r) }, 'キャンセル') : h('button', { class: 'btn small', onclick: () => rerunActionsRun(r) }, '再実行'),
            r.url ? h('button', { class: 'btn small', onclick: () => APP('openExternal', r.url) }, 'GitHubで開く') : null);
        })));
      }
    }

    async function createActionsWorkflow() {
      const templates = await GH('listActionsTemplates', S.repo);
      const r = await formDialog({ title: 'GitHub Actions のワークフローを作る', okLabel: 'ファイルを作る', wide: true,
        intro: 'テンプレートから .github/workflows にファイルを作ります。push などをきっかけにGitHub上でコマンドが実行されるため、記録・アップロードする前に内容を確認してください。',
        fields: [
          { key: 'template', label: 'テンプレート', type: 'select', value: templates[0] && templates[0].id, options: templates.map((t) => ({ value: t.id, label: `${t.label}（${t.filename}）` })) },
          { key: 'filename', label: 'ファイル名（省略可）', placeholder: '空欄ならテンプレートの名前を使います' },
        ] });
      if (!r) return;
      const result = await withBusy('ワークフローを作成中…', () => GH('createLocalActionsWorkflow', S.repo, r));
      if (result) { toast(`${result.filename} を作成しました。内容を確認してからアップロードしてください。`); await loadActions(); }
    }

    async function editActionsWorkflow(filename) {
      const file = await withBusy('ワークフローを読み込み中…', () => GH('readLocalActionsWorkflow', S.repo, filename));
      if (!file) return;
      const r = await formDialog({ title: `ワークフローを編集：${filename}`, okLabel: 'ローカルに保存', wide: true,
        intro: '保存するとこのパソコンのファイルだけが変わります。YAMLの内容を確認してから記録・アップロードしてください。',
        fields: [{ key: 'content', label: 'YAML', type: 'textarea', rows: 20, value: file.content }] });
      if (!r) return;
      const ok = await withBusy('保存中…', () => GH('saveLocalActionsWorkflow', S.repo, filename, r.content));
      if (ok) { toast('ローカルに保存しました ✓'); await loadActions(); }
    }

    async function toggleActionsWorkflow(w) {
      const enabled = w.state !== 'active';
      if (!(await confirmDialog({ title: enabled ? 'ワークフローを有効にしますか？' : 'ワークフローを一時停止しますか？',
        message: enabled ? `「${w.name}」を有効にします。設定された条件に合うと自動実行されます。` : `「${w.name}」を一時停止します。再度有効にするまで実行されません。`, okLabel: enabled ? '有効にする' : '一時停止' }))) return;
      if (await withBusy('設定を変更中…', () => GH('setActionsWorkflowEnabled', S.repo, w.id, enabled))) { toast(enabled ? '有効にしました ✓' : '一時停止しました'); await loadActions(); }
    }

    async function runActionsWorkflow(w) {
      const ref = S.status && S.status.branch || 'main';
      const r = await formDialog({ title: 'ワークフローを手動実行', okLabel: '実行する',
        intro: `「${w.name}」をGitHub上で実行します。実行する分岐に workflow_dispatch が設定され、ワークフローがGitHubへアップロード済みである必要があります。`,
        fields: [
          { key: 'ref', label: '実行する分岐', value: ref, required: true, help: '例：main、develop、feature/example' },
          { key: 'inputs', label: 'ワークフローへの入力（省略可）', type: 'textarea', rows: 3, placeholder: '例：\nname=太郎\nenvironment=staging', help: '入力がある場合は「項目名=値」を1行ずつ入力します。' },
        ] });
      if (!r) return;
      const inputs = {};
      for (const line of String(r.inputs || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        const at = line.indexOf('=');
        if (at < 1) { toast(`入力の形式を確認してください: ${line}`, 'error'); return; }
        const key = line.slice(0, at).trim();
        if (Object.prototype.hasOwnProperty.call(inputs, key)) { toast(`同じ入力項目が重複しています: ${key}`, 'error'); return; }
        inputs[key] = line.slice(at + 1);
      }
      if (!(await confirmDialog({ title: 'GitHub Actionsを実行しますか？', message: `ワークフロー「${w.name}」を「${r.ref}」で実行します。ワークフロー内の処理がGitHub上で動きます。`, okLabel: '実行する' }))) return;
      if (await withBusy('GitHub Actionsを開始中…', () => GH('runActionsWorkflow', S.repo, w.path || String(w.id), r.ref, inputs))) { toast('実行を開始しました ✓'); await loadActions(); }
    }

    async function showActionsRun(r) {
      const result = await withBusy('実行の詳細とログを読み込み中…', async () => {
        const detail = await GH('getActionsRun', S.repo, r.databaseId);
        let log = '';
        try { log = await GH('getActionsRunLog', S.repo, r.databaseId); }
        catch (e) { log = `ログを取得できませんでした。実行中の場合は、完了後にもう一度確認してください。\n\n${e.message}`; }
        return { detail, log };
      });
      if (!result) return;
      const { detail, log } = result;
      const jobs = detail && Array.isArray(detail.jobs) ? detail.jobs : [];
      await modal({ title: `実行 #${r.databaseId}：${r.workflowName || ''}`, wide: true,
        body: h('div', {}, detail ? h('p', { class: 'muted' }, `${detail.displayTitle || ''}　${detail.headBranch || ''}　${detail.status || ''} ${detail.conclusion || ''}`) : null,
          jobs.length ? h('div', { class: 'list' }, jobs.map((j) => h('div', { class: 'row' }, h('span', {}, j.conclusion === 'success' ? '✅' : j.conclusion === 'failure' ? '❌' : '⏳'), h('span', { class: 'grow' }, j.name), h('span', { class: 'muted' }, j.conclusion || j.status)))) : null,
          h('pre', { class: 'actions-log' }, log || 'ログはありません。')),
        buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
    }

    async function cancelActionsRun(r) {
      if (!(await confirmDialog({ title: '実行をキャンセルしますか？', message: `実行 #${r.databaseId} を停止します。`, okLabel: 'キャンセルする', danger: true }))) return;
      if (await withBusy('実行を停止中…', () => GH('cancelActionsRun', S.repo, r.databaseId))) { toast('実行をキャンセルしました'); await loadActions(); }
    }

    async function rerunActionsRun(r) {
      if (!(await confirmDialog({ title: 'ワークフローを再実行しますか？', message: `「${r.workflowName}」の実行 #${r.databaseId} を、同じ内容で再実行します。`, okLabel: '再実行する' }))) return;
      if (await withBusy('再実行を開始中…', () => GH('rerunActionsRun', S.repo, r.databaseId))) { toast('再実行を開始しました ✓'); await loadActions(); }
    }
  }

  return { render, onStatus };
})();
