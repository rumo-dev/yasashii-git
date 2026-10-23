'use strict';
/* 「設定」画面：名前とメール・接続先・管理しないファイル・表示 */
Views.settings = (() => {
  let root;
  function render(container) { root = container; draw(); }
  function onStatus() {}

  async function draw() {
    let user, remotes, ignore, ignoreTemplates;
    try { [user, remotes, ignore, ignoreTemplates] = await Promise.all([G('getUser'), G('remotes'), G('readIgnore'), G('ignoreTemplates')]); }
    catch (e) { clear(root).appendChild(h('div', { class: 'pad' }, e.message)); return; }

    const nameIn = h('input', { type: 'text', value: user.name || user.globalName || '', placeholder: '例：山田 太郎' });
    const mailIn = h('input', { type: 'text', value: user.email || user.globalEmail || '', placeholder: 'you@example.com' });
    const globalChk = h('input', { type: 'checkbox', checked: true });
    const ignoreIn = h('textarea', { rows: 8, class: 'code-input', value: ignore, placeholder: '例：\nnode_modules/\n*.log\n.env' });
    const ignoreTemplateSel = h('select', { style: { width: 'auto' } }, ignoreTemplates.map((t) => h('option', { value: t.value }, t.label)));
    const origChk = h('input', { type: 'checkbox', checked: S.settings.showOriginal !== false, onchange: () => saveSettings({ showOriginal: origChk.checked }).then(() => draw()) });
    const safetyChk = h('input', { type: 'checkbox', checked: S.settings.safetyCheck !== false, onchange: () => saveSettings({ safetyCheck: safetyChk.checked }).then(() => toast(safetyChk.checked ? '安全チェックをオンにしました' : '安全チェックをオフにしました')) });
    const minSel = h('select', { style: { width: 'auto' }, disabled: !S.settings.autoFetch, onchange: () => saveSettings({ autoFetchMin: Number(minSel.value) }) },
      [1, 3, 5, 10, 30].map((m) => h('option', { value: m, selected: (Number(S.settings.autoFetchMin) || 5) === m }, m + '分ごと')));
    const autoChk = h('input', { type: 'checkbox', checked: !!S.settings.autoFetch, onchange: () => { minSel.disabled = !autoChk.checked; saveSettings({ autoFetch: autoChk.checked }).then(() => toast(autoChk.checked ? '定期的な更新確認をオンにしました' : '定期的な更新確認をオフにしました')); } });
    const themes = [
      { id: 'auto', name: 'システムに合わせる', colors: ['#f6f7f9', '#ffffff', '#2f7d5b'] },
      { id: 'light', name: 'リーフ', colors: ['#f6f7f9', '#ffffff', '#2f7d5b'] },
      { id: 'dark', name: 'ダーク', colors: ['#14171a', '#1c2024', '#4cb386'] },
      { id: 'ocean', name: 'オーシャン', colors: ['#eaf4fb', '#f8fcff', '#1677c8'] },
      { id: 'sakura', name: 'さくら', colors: ['#fff0f5', '#fffafd', '#d94f83'] },
      { id: 'lavender', name: 'ラベンダー', colors: ['#f1effb', '#fbfaff', '#7958c8'] },
      { id: 'sunset', name: 'サンセット', colors: ['#fff1e5', '#fffaf5', '#d56a32'] },
      { id: 'forest', name: 'フォレスト', colors: ['#111a17', '#19241f', '#73c99a'] },
      { id: 'midnight', name: 'ミッドナイト', colors: ['#151522', '#1d1d2c', '#9b8cff'] },
      { id: 'nord', name: 'ノルド', colors: ['#2e3440', '#3b4252', '#88c0d0'] },
    ];
    const currentTheme = S.settings.theme || 'auto';
    const themeOptions = h('div', { class: 'theme-options', role: 'group', 'aria-label': 'テーマを選択' }, themes.map((t) =>
      h('button', { type: 'button', class: `theme-option${currentTheme === t.id ? ' selected' : ''}`, 'aria-pressed': currentTheme === t.id, title: t.name,
        onclick: async () => { await saveSettings({ theme: t.id }); draw(); } },
        h('span', { class: 'theme-preview', style: { background: t.colors[0] } },
          h('i', { style: { background: t.colors[1] } }), h('i', { style: { background: t.colors[2] } })),
        h('span', {}, t.name))));

    const updChk = h('input', { type: 'checkbox', checked: S.settings.autoUpdateCheck !== false, onchange: () => saveSettings({ autoUpdateCheck: updChk.checked }).then(() => toast(updChk.checked ? '新しい版の自動確認をオンにしました' : '新しい版の自動確認をオフにしました')) });
    const updStatus = h('div', { class: 'muted', style: { marginBottom: '10px' } });
    const updBtns = h('div', { class: 'btn-row', style: { marginBottom: '10px' } });
    const drawUpd = () => {
      const u = Upd.state() || { status: 'idle', currentVersion: S.version };
      const txt = { disabled: u.reason || '更新の確認は使えません。', checking: '新しい版を確認しています…', uptodate: `最新の版です。（v${u.currentVersion}）`,
        available: `新しい版 v${u.version} があります。（いまは v${u.currentVersion}）`, downloading: `v${u.version} をダウンロード中… ${u.percent || 0}%`,
        downloaded: `v${u.version} の準備ができました。再起動すると新しい版になります。` }[u.status] || `いまの版：v${u.currentVersion || S.version || ''}${u.error ? '　' + u.error : ''}`;
      updStatus.textContent = txt;
      clear(updBtns).append(...[
        h('button', { class: 'btn', disabled: ['disabled', 'checking', 'downloading'].includes(u.status), onclick: () => Upd.checkNow() }, '🔍 新しい版を確認'),
        u.status === 'available' ? h('button', { class: 'btn primary', onclick: () => Upd.startUpdate() }, u.mode === 'auto' ? '⬇ 更新する' : '🌐 ダウンロードページを開く') : null,
        u.status === 'available' && u.notes ? h('button', { class: 'btn', onclick: () => Upd.showNotes() }, '更新内容を見る') : null,
        u.status === 'downloaded' ? h('button', { class: 'btn primary', onclick: () => Upd.restartNow() }, '🔄 再起動して更新') : null].filter(Boolean));
    };
    const updCard = h('div', { class: 'card' }, h('h3', {}, '🆕 アプリの更新'),
      updStatus, updBtns,
      h('label', { class: 'check' }, updChk, h('span', {}, '起動中、ときどき新しい版がないか自動で確認して、見つかったら知らせる（おすすめ）',
        h('div', { class: 'muted', style: { fontSize: '12px' } }, '知らせるだけで、勝手に入れ替えることはありません。「更新する」を押したときだけ更新します。'))));
    drawUpd(); Upd.bind(updCard, drawUpd);

    clear(root).appendChild(h('div', { class: 'pad' },
      h('h2', {}, '⚙️ 設定'), h('p', { class: 'sub' }, 'はじめに「名前」と「メールアドレス」を設定しておくと、記録に作成者として残ります。'),

      h('div', { class: 'card' }, h('h3', {}, '👤 記録に残す名前'),
        user.name || user.globalName ? null : h('p', { class: 'danger-note', style: { padding: '8px 12px', borderRadius: '8px', background: 'var(--warn-bg)', color: 'var(--warn)' } }, '⚠ まだ設定されていません。「変更を記録」する前に設定してください。'),
        h('label', { class: 'field' }, h('span', {}, '名前'), nameIn),
        h('label', { class: 'field' }, h('span', {}, 'メールアドレス'), mailIn, h('small', {}, 'GitHubに登録したメールアドレスにすると、自分の記録として表示されます。迷ったら下の「GitHubアカウントから自動入力」がおすすめです。')),
        h('div', { class: 'btn-row', style: { marginBottom: '10px' } },
          h('button', { class: 'btn', onclick: async () => {
            const p = await withBusy('GitHubから読み込み中…', () => GH('myProfile'));
            if (!p) return;
            nameIn.value = p.name; mailIn.value = p.email;
            toast(`「${p.login}」の情報を入力しました。「保存」を押すと反映されます。`);
          } }, '🪄 GitHubアカウントから自動入力'),
          h('span', { class: 'muted', style: { fontSize: '12px', alignSelf: 'center' } }, 'メールは、本当のアドレスが公開されない GitHub 専用のもの（…@users.noreply.github.com）になります。')),
        h('label', { class: 'check', style: { marginBottom: '10px' } }, globalChk, h('span', {}, 'このパソコンのすべてのプロジェクトで使う（おすすめ）')),
        h('button', { class: 'btn primary', onclick: async () => { const ok = await withBusy('保存中…', () => G('setUser', { name: nameIn.value, email: mailIn.value, global: globalChk.checked })); if (ok) toast('保存しました ✓'); } }, '保存')),

      h('div', { class: 'card' }, h('h3', {}, '☁️ ', termLabel('remote'), '（アップロード・取り込みの相手先）'),
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'ふだんは触る必要はありません。「アップロード」を押すと、GitHubへの接続は自動で設定されます。（GitHub以外のサーバーを使う方向けの手動設定です）'),
        h('div', { class: 'list', style: { marginBottom: '10px' } }, remotes.length ? remotes.map((r) => h('div', { class: 'row' },
          h('b', {}, r.name), h('div', { class: 'grow mono title', style: { fontSize: '12px' } }, r.fetchUrl),
          h('button', { class: 'btn small', onclick: () => editRemote(r) }, 'URLを変更'),
          h('button', { class: 'btn small danger', onclick: () => delRemote(r) }, '削除'))) : h('div', { class: 'empty' }, 'まだ接続先がありません。（最初の「アップロード」で自動的に作られます）')),
        h('button', { class: 'btn', onclick: addRemote }, '＋ 接続先を追加')),

      h('div', { class: 'card' }, h('h3', {}, '🚫 ', termLabel('gitignore')),
        h('p', { class: 'muted', style: { marginTop: 0 } }, '1行に1つ、記録したくないファイル名やフォルダ名を書きます。（パスワードを書いたファイルなどは必ず入れましょう）'),
        h('div', { class: 'btn-row', style: { marginBottom: '8px' } },
          ignoreTemplateSel,
          h('button', { class: 'btn', onclick: async () => {
            if (!ignoreTemplateSel.value || ignoreTemplateSel.value === 'none') return toast('テンプレートを選んでください。', 'error');
            const result = await withBusy('テンプレートを追加中…', () => G('applyIgnoreTemplate', ignoreTemplateSel.value));
            if (result) { ignoreIn.value = result.text; toast(result.added ? `${result.added} 件の設定を追加しました ✓` : 'テンプレートの設定はすでに含まれています'); }
          } }, 'テンプレートを追加')),
        ignoreIn,
        h('div', { class: 'btn-row', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary', onclick: async () => { const ok = await withBusy('保存中…', () => G('writeIgnore', ignoreIn.value)); if (ok) { toast('保存しました ✓'); refreshAll(); } } }, '保存'),
          ['node_modules/', '.env', '*.log', '.DS_Store'].map((p) => h('button', { class: 'btn small', onclick: () => { ignoreIn.value = (ignoreIn.value && !ignoreIn.value.endsWith('\n') ? ignoreIn.value + '\n' : ignoreIn.value) + p + '\n'; } }, '＋ ' + p)))),

      h('div', { class: 'card' }, h('h3', {}, '🛡 アップロード前の安全チェック'),
        h('label', { class: 'check' }, safetyChk, h('span', {}, 'アップロードの前に、パスワード・APIキー・.env・100MBを超える大きなファイルが入っていないか確認する（おすすめ）',
          h('div', { class: 'muted', style: { fontSize: '12px' } }, 'これから送る記録だけを、このパソコンの中で調べます。内容が外部に送られることはありません。')))),

      h('div', { class: 'card' }, h('h3', {}, '🔄 更新の自動確認'),
        h('label', { class: 'check', style: { marginBottom: '10px' } }, autoChk, h('span', {}, '一定時間ごとに、サーバーに新しい更新がないか自動で確認する',
          h('div', { class: 'muted', style: { fontSize: '12px' } }, '起動後に確認し、その後は1時間ごとに確認します。オンに切り替えたときもすぐ確認します。確認するだけで、手元のファイルは変わりません。アプリを開いている間だけ動きます。（初期設定はオン）'))),
        h('label', { class: 'field' }, h('span', {}, '確認する間隔'), minSel)),

      updCard,

      h('div', { class: 'card' }, h('h3', {}, '🎨 表示'),
        h('label', { class: 'check', style: { marginBottom: '10px' } }, origChk, h('span', {}, 'やさしい言い方のとなりに、元のGit用語も小さく表示する', h('div', { class: 'muted', style: { fontSize: '12px' } }, '例：アップロード push　──　他の資料やチームの会話で使われる用語を、自然に覚えられます。'))),
        h('div', { class: 'field' }, h('span', {}, 'テーマ'), themeOptions),
        h('button', { class: 'btn', onclick: showGlossary }, '📖 用語の対応表を見る')),

      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'やさしいGit  v' + (S.version || ''))));
  }

  async function addRemote() {
    const r = await formDialog({ title: '接続先を追加', okLabel: '追加する', fields: [
      { key: 'name', label: '名前', value: 'origin', required: true, help: '通常は origin のままでOKです。' },
      { key: 'url', label: 'URL', required: true, placeholder: 'https://github.com/ユーザー名/プロジェクト名.git', mono: true }] });
    if (!r) return;
    const ok = await withBusy('追加中…', () => G('addRemote', r.name, normalizeRepoUrl(r.url)));
    if (ok) { toast('追加しました ✓'); await refreshAll(); draw(); }
  }
  async function editRemote(rem) {
    const r = await formDialog({ title: `「${rem.name}」のURLを変更`, okLabel: '変更する', fields: [{ key: 'url', label: 'URL', value: rem.fetchUrl, required: true, mono: true }] });
    if (!r) return;
    const ok = await withBusy('変更中…', () => G('setRemoteUrl', rem.name, normalizeRepoUrl(r.url)));
    if (ok) { toast('変更しました ✓'); draw(); }
  }
  async function delRemote(rem) {
    if (!(await confirmDialog({ title: `接続先「${rem.name}」を削除しますか？`, message: 'この端末の設定から外すだけで、サーバー上のデータは消えません。', okLabel: '削除する', danger: true }))) return;
    if (await withBusy('削除中…', () => G('removeRemote', rem.name))) { toast('削除しました'); await refreshAll(); draw(); }
  }

  return { render, onStatus };
})();
