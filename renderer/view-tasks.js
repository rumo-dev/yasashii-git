'use strict';
/* 「タスク」画面：GitHubの課題（Issue）を「未着手／進行中／完了」のボードで管理する */
Views.tasks = (() => {
  let root, tasks = null, me = null, onlyMine = false, token = 0;
  const COLS = [
    { id: 'todo', ico: '📋', label: '未着手', hint: 'まだ取りかかっていないタスク' },
    { id: 'doing', ico: '🚧', label: '進行中', hint: 'いま取りかかっているタスク（GitHubでは「進行中」ラベルが付きます）' },
    { id: 'done', ico: '✅', label: '完了', hint: '終わったタスク（GitHubでは課題が「完了（Closed）」になります）' },
  ];

  function render(container) { root = container; draw(true); }
  function onStatus() { /* GitHub上の情報なので、自動更新はしない（「更新」ボタンで再読み込み） */ }

  async function draw(first) {
    const my = ++token;
    if (!S.hasRemote) {
      clear(root).appendChild(h('div', { class: 'pad' }, h('h2', {}, '📋 タスク'), h('div', { class: 'card' }, 'タスク管理はGitHubの「課題（Issue）」を使います。まず「アップロード」でGitHubにつなぎましょう。')));
      return;
    }
    if (first || !tasks) clear(root).appendChild(h('div', { class: 'pad' }, h('h2', {}, '📋 タスク'), h('div', { class: 'empty' }, '読み込み中…')));
    try {
      const [list, login] = await Promise.all([GH('listTasks', S.repo), me ? me : GH('myLogin').catch(() => null)]);
      if (my !== token) return;
      tasks = list; me = login;
    } catch (e) { if (my === token) clear(root).appendChild(h('div', { class: 'pad' }, h('h2', {}, '📋 タスク'), h('div', { class: 'card' }, e.message))); return; }
    paint();
  }

  const mine = (t) => !!me && (t.assignees || []).some((a) => a.login === me);

  function paint() {
    const shown = tasks.filter((t) => !onlyMine || mine(t));
    const total = shown.length, done = shown.filter((t) => t.status === 'done').length;
    const pct = total ? Math.round(done * 100 / total) : 0;
    clear(root).appendChild(h('div', { class: 'pad tasks' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } },
        h('div', { style: { flex: 1, minWidth: '240px' } }, h('h2', {}, '📋 タスク', settingsRef.showOriginal ? h('span', { class: 'en' }, 'issue') : null),
          h('p', { class: 'sub' }, 'GitHubの課題（Issue）をそのままタスクとして管理します。カードをドラッグするか、「→」で次の状態へ進められます。')),
        h('div', { class: 'btn-row' },
          h('label', { class: 'check', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: onlyMine, onchange: (e) => { onlyMine = e.target.checked; paint(); } }), h('span', {}, '自分の担当だけ')),
          h('button', { class: 'btn', onclick: () => draw(false) }, '🔄 更新'),
          h('button', { class: 'btn primary', onclick: () => createTask('todo') }, '＋ タスクを追加'))),
      h('div', { class: 'task-progress', title: `${done} / ${total} 完了` },
        h('div', { class: 'bar' }, h('div', { style: { width: pct + '%' } })), h('span', { class: 'muted' }, `完了 ${done} / ${total}（${pct}%）`)),
      h('div', { class: 'board' }, COLS.map((c) => column(c, shown.filter((t) => t.status === c.id))))));
  }

  function column(c, list) {
    const body = h('div', { class: 'col-body' }, list.length ? list.map(card) : h('div', { class: 'empty', style: { padding: '14px' } }, 'ここにはありません'));
    const col = h('div', { class: 'col col-' + c.id, 'data-status': c.id },
      h('div', { class: 'col-head', title: c.hint }, h('span', { class: 'grow' }, `${c.ico} ${c.label}`), h('span', { class: 'pill' }, String(list.length)),
        c.id !== 'done' ? h('button', { class: 'btn small ghost', title: `「${c.label}」にタスクを追加`, onclick: () => createTask(c.id) }, '＋') : null),
      body);
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('over');
      const n = Number(e.dataTransfer.getData('text/plain')); const t = tasks.find((x) => x.number === n);
      if (t && t.status !== c.id) move(t, c.id);
    });
    return col;
  }

  function card(t) {
    const idx = COLS.findIndex((c) => c.id === t.status);
    const labels = (t.labels || []).filter((l) => l.name !== '進行中');
    const el = h('div', { class: 'task-card' + (mine(t) ? ' mine' : ''), draggable: 'true', onclick: () => detail(t) },
      h('div', { class: 'task-title' }, h('span', { class: 'muted' }, `#${t.number} `), t.title),
      labels.length ? h('div', { class: 'task-meta' }, labels.map((l) => h('span', { class: 'pill blue' }, l.name))) : null,
      h('div', { class: 'task-meta' },
        (t.assignees || []).length ? h('span', { class: 'pill ' + (mine(t) ? 'green' : '') }, '👤 ' + t.assignees.map((a) => a.login).join(', ')) : h('span', { class: 'muted' }, '担当なし'),
        t.comments ? h('span', { class: 'muted' }, `💬 ${t.comments}`) : null),
      h('div', { class: 'task-acts' },
        idx > 0 ? h('button', { class: 'btn small ghost', title: `「${COLS[idx - 1].label}」へ戻す`, onclick: (e) => { e.stopPropagation(); move(t, COLS[idx - 1].id); } }, '←') : null,
        h('span', { class: 'grow' }),
        idx < COLS.length - 1 ? h('button', { class: 'btn small', title: `「${COLS[idx + 1].label}」へ進める`, onclick: (e) => { e.stopPropagation(); move(t, COLS[idx + 1].id); } }, COLS[idx + 1].label + ' へ →') : null));
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(t.number)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  }

  /* ----------------- 操作 ----------------- */
  async function move(t, status) {
    const prev = t.status;
    t.status = status;                        // 先に画面へ反映（早く見える）
    paint();
    const r = await withBusy('更新中…', () => GH('setTaskStatus', S.repo, t.number, status, { state: t.state, doing: prev === 'doing' }));
    if (r === undefined) t.status = prev;     // 失敗したら元に戻す
    await draw(false);
  }
  async function createTask(status) {
    const r = await formDialog({ title: '＋ タスクを追加', okLabel: '追加する',
      intro: 'GitHubに課題（Issue）として登録されます。チームの全員から見えます。',
      fields: [
        { key: 'title', label: 'タスクの名前', required: true, placeholder: '例：トップページの写真を差し替える' },
        { key: 'body', label: 'くわしい内容（省略できます）', type: 'textarea', rows: 5 },
        { key: 'status', label: '最初の状態', type: 'select', value: status, options: COLS.slice(0, 2).map((c) => ({ value: c.id, label: `${c.ico} ${c.label}` })) },
        { key: 'assignMe', label: '担当を自分にする', type: 'checkbox', value: false }] });
    if (!r) return;
    if (await withBusy('追加中…', () => GH('createTask', S.repo, r))) { toast('追加しました ✓'); draw(false); }
  }
  async function detail(t) {
    const assigned = mine(t);
    const act = async (fn) => { document.querySelector('.overlay')?.remove(); await fn(); };
    const body = h('div', {},
      h('div', { class: 'task-meta', style: { marginBottom: '8px' } },
        h('span', { class: 'pill ' + (t.status === 'done' ? 'green' : t.status === 'doing' ? 'yellow' : '') }, COLS.find((c) => c.id === t.status).label),
        h('span', { class: 'muted' }, `作成：${t.author ? t.author.login : ''}　${relTime(t.createdAt)}`)),
      h('div', { class: 'task-body' }, t.body && t.body.trim() ? t.body : h('span', { class: 'muted' }, '（くわしい内容はありません）')),
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        h('button', { class: 'btn small', onclick: () => act(() => assign(t, !assigned)) }, assigned ? '担当から外れる' : '👤 担当を自分にする'),
        h('button', { class: 'btn small', onclick: () => act(() => edit(t)) }, '✏️ 名前・内容を編集'),
        h('button', { class: 'btn small', onclick: () => act(() => comment(t)) }, '💬 コメント'),
        h('button', { class: 'btn small', onclick: () => APP('openExternal', t.url).catch(showError) }, '🌐 ブラウザで開く')));
    await modal({ title: `#${t.number} ${t.title}`, wide: true, body, buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
  }
  async function assign(t, on) {
    if (await withBusy('更新中…', () => GH('assignTaskToMe', S.repo, t.number, on))) { toast(on ? '担当になりました' : '担当から外れました'); draw(false); }
  }
  async function edit(t) {
    const r = await formDialog({ title: `#${t.number} を編集`, okLabel: '保存する', fields: [
      { key: 'title', label: 'タスクの名前', value: t.title, required: true },
      { key: 'body', label: 'くわしい内容', type: 'textarea', rows: 6, value: t.body || '' }] });
    if (!r) return;
    if (await withBusy('保存中…', () => GH('editTask', S.repo, t.number, r))) { toast('保存しました ✓'); draw(false); }
  }
  async function comment(t) {
    const r = await formDialog({ title: `#${t.number} にコメント`, okLabel: '送信する', fields: [{ key: 'body', label: 'コメント', type: 'textarea', rows: 5, required: true }] });
    if (!r) return;
    if (await withBusy('送信中…', () => GH('commentIssue', S.repo, t.number, r.body))) { toast('送信しました ✓'); draw(false); }
  }

  return { render, onStatus };
})();
