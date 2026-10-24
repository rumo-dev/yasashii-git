'use strict';
/* 「タスク」画面：GitHubの課題（Issue）を「未着手／進行中／完了」のボードで管理する */
Views.tasks = (() => {
  let root, tasks = null, me = null, onlyMine = false, searchText = '', priorityFilter = 'all', sortBy = 'priority', token = 0;
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
    const rank = { high: 0, normal: 1, low: 2 };
    const shown = tasks.filter((t) => {
      if (onlyMine && !mine(t)) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      const query = searchText.trim().toLocaleLowerCase();
      if (!query) return true;
      const haystack = [t.title, t.body, `#${t.number}`, ...(t.labels || []).map((l) => l.name), ...(t.assignees || []).map((a) => a.login)].join(' ').toLocaleLowerCase();
      return haystack.includes(query);
    }).sort((a, b) => {
      if (sortBy === 'priority') return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || new Date(b.createdAt) - new Date(a.createdAt);
      if (sortBy === 'updated') return new Date(b.updatedAt) - new Date(a.updatedAt);
      if (sortBy === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      if (sortBy === 'comments') return (b.comments || 0) - (a.comments || 0);
      return a.title.localeCompare(b.title, 'ja');
    });
    const total = shown.length, done = shown.filter((t) => t.status === 'done').length;
    const pct = total ? Math.round(done * 100 / total) : 0;
    clear(root).appendChild(h('div', { class: 'pad tasks' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } },
        h('div', { style: { flex: 1, minWidth: '240px' } }, h('h2', {}, '📋 タスク', settingsRef.showOriginal ? h('span', { class: 'en' }, 'issue') : null),
          h('p', { class: 'sub' }, 'GitHubの課題（Issue）をそのままタスクとして管理します。カードをドラッグするか、「→」で次の状態へ進められます。')),
        h('div', { class: 'btn-row' },
          h('label', { class: 'check', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: onlyMine, onchange: (e) => { onlyMine = e.target.checked; paint(); } }), h('span', {}, '自分の担当だけ')),
          h('input', { class: 'input', type: 'search', placeholder: 'タイトル・内容・担当・ラベル・番号で検索', value: searchText, style: { width: '250px' }, onchange: (e) => { searchText = e.target.value; paint(); }, onkeydown: (e) => { if (e.key === 'Enter') { searchText = e.target.value; paint(); } } }),
          h('select', { class: 'input', value: priorityFilter, style: { width: 'auto' }, onchange: (e) => { priorityFilter = e.target.value; paint(); } }, [['all', 'すべての緊急度'], ['high', '🔴 高'], ['normal', '🟡 中'], ['low', '🟢 低']].map(([v, label]) => h('option', { value: v, selected: v === priorityFilter }, label))),
          h('select', { class: 'input', value: sortBy, style: { width: 'auto' }, onchange: (e) => { sortBy = e.target.value; paint(); } }, [['priority', '緊急度順'], ['updated', '更新が新しい順'], ['oldest', '作成が古い順'], ['title', '名前順'], ['comments', 'コメントが多い順']].map(([v, label]) => h('option', { value: v, selected: v === sortBy }, label))),
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
        h('span', { class: 'pill ' + (t.priority === 'high' ? 'red' : t.priority === 'low' ? 'green' : 'yellow') }, ({ high: '🔴 緊急度：高', normal: '🟡 緊急度：中', low: '🟢 緊急度：低' })[t.priority] || '🟡 緊急度：中'),
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
    if (status === 'doing' && prev !== 'doing') {
      let flow, githubFlow, existingBranch;
      try {
        [flow, githubFlow, existingBranch] = await Promise.all([G('gitFlowConfig'), G('githubFlowConfig'), G('getTaskBranch', t.number)]);
      } catch (e) { await showError(e); return; }
      if (!existingBranch) {
        try { existingBranch = await findTaskBranch(t, flow, githubFlow); } catch (e) { await showError(e); return; }
      }
      let flowType = null;
      if (flow && !existingBranch) {
        const choice = await formDialog({ title: 'GitFlowの作業の種類を選ぶ', okLabel: '次へ',
          intro: '通常の機能追加はfeature、公開に向けた仕上げはrelease、本番環境の緊急修正はhotfixを選びます。',
          fields: [{ key: 'type', label: '作業の種類', type: 'select', value: 'feature', options: [
            { value: 'feature', label: 'feature（機能追加・通常の修正）' },
            { value: 'release', label: 'release（公開前の仕上げ）' },
            { value: 'hotfix', label: 'hotfix（公開済み機能の緊急修正）' },
          ] }] });
        if (!choice) return;
        flowType = choice.type;
      }
      const st = await G('status');
      if (st.operation) { toast('進行中の合流などを完了または中止してから、タスクを進行中にしてください。', 'error'); return; }
      let stashName = '';
      if (st.files.length) {
        const saved = await formDialog({ title: '作業中の変更を一時退避', okLabel: '退避して進む', intro: '別のタスクの変更があるため、先にスタッシュへ保存します。スタッシュ名を入力してください。', fields: [{ key: 'message', label: 'スタッシュ名', required: true, placeholder: t.title }] });
        if (!saved) return;
        stashName = saved.message;
        try { await withBusyThrow('変更をしまっています…', () => G('stashSave', { message: saved.message, includeUntracked: true })); }
        catch (e) { await showError(e); toast(`変更は一時退避「${stashName}」に保存されたままです。`, 'error'); return; }
      }
      try {
        if (existingBranch) await withBusyThrow('タスクの分岐へ切り替え中…', () => G('switchBranch', existingBranch));
        else if (flowType) await withBusyThrow('GitFlowのタスク分岐を作成中…', () => G('beginGitFlowBranch', { type: flowType, name: taskBranch(t), issueNumber: t.number }));
        else if (githubFlow) await withBusyThrow('GitHub Flowの作業分岐を作成中…', () => G('beginGitHubFlowBranch', { name: taskBranch(t), issueNumber: t.number }));
        else await withBusyThrow('タスクの分岐を作成中…', () => G('createTaskBranch', { name: taskBranch(t), issueNumber: t.number }));
      } catch (e) { await showError(e); if (stashName) toast(`変更は一時退避「${stashName}」に保存されたままです。`, 'error'); return; }
    }
    if (status === 'done' && prev !== 'done') {
      try {
        if (!await finishTaskBranch(t)) return;
      } catch (e) { showError(e); return; }
    }
    t.status = status;                        // 先に画面へ反映（早く見える）
    paint();
    const r = await withBusy('更新中…', () => GH('setTaskStatus', S.repo, t.number, status, { state: t.state, doing: prev === 'doing' }));
    if (r === undefined) t.status = prev;     // 失敗したら元に戻す
    await draw(false);
  }

  function taskBranch(t) {
    // Gitのブランチ名に使えない文字だけを整え、日本語を含むタイトルはそのまま残す。
    let name = String(t.title || '').trim().replace(/[\s\x00-\x20~^:?*\[\\/]/g, '-').replace(/\.\./g, '-').replace(/@\{/g, '-');
    // Gitは先頭のハイフンもブランチ名として受け付けない。
    name = name.replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/i, '').slice(0, 180).replace(/[.-]+$/g, '');
    // 異なる課題に同じタイトルが付いても、同じ作業ブランチを共有しない。
    return `${name || 'task'}-${t.number}`;
  }

  function legacyTaskBranch(t) {
    return String(t.title || '').trim().replace(/[\s\x00-\x20~^:?*\[\\/]/g, '-').replace(/\.\./g, '-').replace(/@\{/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/i, '') || `issue-${t.number}`;
  }

  async function findTaskBranch(t, flow, githubFlow) {
    const expected = taskBranch(t);
    const legacy = legacyTaskBranch(t);
    const branches = (await G('branches')).local.map((b) => b.name);
    const candidates = new Set(branches.filter((name) => name === expected || name === legacy));
    if (flow) for (const type of ['feature', 'release', 'hotfix']) {
      for (const suffix of new Set([expected, legacy])) {
        const name = flow.prefixes[type] + suffix;
        if (branches.includes(name)) candidates.add(name);
      }
    }
    if (githubFlow) {
      const name = githubFlow.prefix + expected;
      if (branches.includes(name)) candidates.add(name);
      const oldName = githubFlow.prefix + legacy;
      if (branches.includes(oldName)) candidates.add(oldName);
    }
    if (candidates.size !== 1) return null;
    const branch = [...candidates][0];
    await G('bindTaskBranch', t.number, branch);
    return branch;
  }

  async function finishTaskBranch(t) {
    const flow = await G('gitFlowConfig');
    const githubFlow = await G('githubFlowConfig');
    const branch = await G('getBoundTaskBranch', t.number) || await G('getTaskBranch', t.number) || await findTaskBranch(t, flow, githubFlow) || taskBranch(t);
    const status = await G('status');
    const branches = await G('branches');
    if (status.files.length) throw new Error('未コミットの変更があります。変更を記録してから完了にしてください。');
    const flowType = flow && ['feature', 'release', 'hotfix'].find((type) => branch.startsWith(flow.prefixes[type]) && branch.length > flow.prefixes[type].length);
    if (flowType) {
      let tagName = '';
      if (flowType === 'release' || flowType === 'hotfix') {
        const result = await formDialog({ title: `${flowType === 'release' ? 'リリース' : '緊急修正'}を完了`, okLabel: '合流して完了',
          intro: `「${branch}」を本番用「${flow.productionBranch}」と開発用「${flow.developmentBranch}」に取り込み、バージョンの目印を付けます。`,
          fields: [{ key: 'tag', label: 'バージョン（目印）', placeholder: '例：1.4.3', required: true,
            help: flow.prefixes.versiontag ? `目印には「${flow.prefixes.versiontag}」が自動で付きます。` : '目印の名前に使うバージョンを入力してください。' }] });
        if (!result) return false;
        tagName = result.tag;
      } else if (!await confirmDialog({ title: '機能の作業を完了しますか？', message: `「${branch}」を開発用「${flow.developmentBranch}」に取り込みます。`, okLabel: '合流して完了' })) return false;
      const finished = await withBusyThrow('最新の状態を確認して、GitFlowの変更を取り込み中…', () => G('finishGitFlowBranch', { branch, tagName }));
      if (finished && finished.conflict) { await afterConflictCheck(finished, null); return false; }
      if (finished) return true;
      return false;
    }
    const pr = await withBusyThrow('GitHubの提案を確認中…', () => GH('findPRForBranch', S.repo, branch));
    if (pr && pr.state === 'MERGED') {
      await G('removeTaskBranchBinding', branch);
      return true;
    }
    if (pr && pr.state === 'CLOSED') {
      if (!await confirmDialog({ title: '閉じた提案をもう一度開きますか？', message: `「${pr.title}」は取り込まれずに閉じられています。もう一度レビューしてもらうため、同じ提案を開き直します。`, okLabel: '開き直す' })) return false;
      await withBusyThrow('提案を開き直しています…', () => GH('reopenPR', S.repo, pr.number));
      if (pr.url) APP('openExternal', pr.url).catch(() => {});
      toast('提案を開き直しました。取り込み後にタスクを完了してください。');
      return false;
    }
    if (pr && pr.state === 'OPEN') {
      if (pr.url) APP('openExternal', pr.url).catch(() => {});
      toast(`#${pr.number} はレビュー中です。取り込まれるとGitHubがタスクを完了にします。`);
      return false;
    }
    if (!branches.local.some((b) => b.name === branch)) throw new Error(`タスクの作業分岐「${branch}」が手元にありません。GitHubで提案を確認するか、作業分岐を復元してください。`);
    const repoInfo = await withBusyThrow('取り込み先を確認中…', () => GH('currentRepo', S.repo));
    const base = githubFlow && githubFlow.baseBranch || repoInfo && repoInfo.defaultBranchRef && repoInfo.defaultBranchRef.name;
    if (!base) throw new Error('GitHubの標準の取り込み先を確認できません。GitHub画面から提案を作成してください。');
    const created = await withBusyThrow('変更の提案を作成中…', () => GH('createPR', S.repo, {
      title: t.title, body: `Closes #${t.number}\n\nこの提案はタスク #${t.number} の変更です。レビュー後、GitHubで取り込んでください。`, base, head: branch,
    }));
    if (created && created.url) APP('openExternal', created.url).catch(() => {});
    toast('変更の提案を作りました。レビュー後に取り込まれると、タスクも自動で完了します。');
    return false;
  }
  async function createTask(status) {
    const r = await formDialog({ title: '＋ タスクを追加', okLabel: '追加する',
      intro: 'GitHubに課題（Issue）として登録されます。チームの全員から見えます。',
      fields: [
        { key: 'title', label: 'タスクの名前', required: true, placeholder: '例：トップページの写真を差し替える' },
        { key: 'body', label: 'くわしい内容（省略できます）', type: 'textarea', rows: 5 },
        { key: 'status', label: '最初の状態', type: 'select', value: status, options: COLS.slice(0, 2).map((c) => ({ value: c.id, label: `${c.ico} ${c.label}` })) },
        { key: 'priority', label: '緊急度', type: 'select', value: 'normal', options: [{ value: 'high', label: '🔴 高（急いで対応）' }, { value: 'normal', label: '🟡 中（通常）' }, { value: 'low', label: '🟢 低（余裕あり）' }] },
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
        h('button', { class: 'btn small danger', onclick: () => act(() => deleteTask(t)) }, '🗑️ タスクを削除'),
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
  async function deleteTask(t) {
    const confirmed = await confirmDialog({
      title: `#${t.number} を削除しますか？`,
      message: `「${t.title}」をGitHubから完全に削除します。タスクの内容やコメントは失われ、元に戻せません。`,
      okLabel: '完全に削除', danger: true,
      note: '削除にはリポジトリでIssueを削除できる権限が必要です。'
    });
    if (!confirmed) return;
    if (await withBusy('削除中…', () => GH('deleteIssue', S.repo, t.number))) {
      toast('タスクを削除しました');
      tasks = null;
      draw(true);
    }
  }

  return { render, onStatus };
})();
