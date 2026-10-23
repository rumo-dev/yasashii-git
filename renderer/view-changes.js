'use strict';
/* 「変更」画面：記録に含めるファイルの選択・変更内容の確認・記録（コミット） */
Views.changes = (() => {
  let sel = null;               // { path, mode: 'staged'|'unstaged'|'conflict', untracked }
  let listsEl, opEl, diffHead, diffBody, commitBox, layoutEl, summaryEl, bodyEl, amendEl, commitBtn, commitPushBtn, counterEl, undoBtn;
  let diffToken = 0;
  const rangeState = { staged: { anchor: null, order: [] }, unstaged: { anchor: null, order: [] } };
  const rangeSelection = { staged: new Set(), unstaged: new Set() };
  const draft = { summary: '', body: '', amend: false, auto: '', edited: false }; // auto=最後に自動で入れた下書き / edited=本人が書き換えたら true（以後は上書きしない）
  let autoEl;

  const OP_NAME = { merge: '合流', revert: '取り消しの記録づくり', 'cherry-pick': '記録のコピー', rebase: '付け替え' };

  function render(container) {
    listsEl = h('div', {}); opEl = h('div', {});
    summaryEl = h('input', { type: 'text', placeholder: '例：トップページの文言を修正', maxLength: 200, value: draft.summary, oninput: () => { draft.summary = summaryEl.value; draft.edited = true; updateCommit(); } });
    bodyEl = h('textarea', { class: 'commit-details', placeholder: 'くわしい説明（省略できます）', rows: 3, value: draft.body, oninput: () => { draft.body = bodyEl.value; } });
    counterEl = h('div', { class: 'counter' });
    autoEl = h('div', { class: 'auto-memo' });
    amendEl = h('input', { type: 'checkbox', checked: draft.amend, onchange: onAmend });
    commitBtn = h('button', { class: 'btn primary', style: { justifyContent: 'center' }, onclick: () => doCommit(false) });
    commitPushBtn = h('button', { class: 'btn commit-push', style: { justifyContent: 'center' }, title: '変更を記録して、そのままGitHubへアップロードします', onclick: () => doCommit(true) }, '⬆️ 記録して、そのままアップロード');
    undoBtn = h('button', { class: 'btn commit-undo', title: '直前の記録をなかったことにします。ファイルの中身は変わらず、「記録に含める」状態に戻ります。', onclick: doUndo }, h('span', { class: 'btn-label' }, '↩ 直前の記録を戻す', termOriginal('reset'), '（変更は残ります）'));
    commitBox = h('div', { class: 'commit-box' },
      h('div', { style: { fontWeight: 700 } }, '📝 ', termLabel('commit')),
      h('div', { class: 'commit-summary-group' }, summaryEl, autoEl, counterEl),
      bodyEl,
      h('div', { class: 'commit-actions' },
        h('label', { class: 'check commit-amend-control', title: hint('amend') }, amendEl, h('span', {}, termLabel('amend'), h('span', { class: 'muted' }, '（まだアップロードしていない記録だけにしましょう）'))),
        commitBtn, commitPushBtn, undoBtn));
    diffHead = h('div', { class: 'pane-head' }, h('span', { class: 'grow' }, '詳細'));
    diffBody = h('div', { style: { flex: 1, overflow: 'auto' } });
    const workArea = h('div', { class: 'split changes' },
      h('div', { class: 'pane changes-list-pane' }, opEl, listsEl),
      h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', title: 'ドラッグして幅を変更' }),
      h('div', { class: 'pane changes-detail-pane' }, diffHead, diffBody));
    const rowSplitter = h('div', { class: 'changes-row-splitter', role: 'separator', 'aria-orientation': 'horizontal', title: 'ドラッグして変更一覧と記録欄の高さを調整' });
    layoutEl = h('div', { class: 'changes-layout' }, workArea, rowSplitter, commitBox);
    container.appendChild(layoutEl);
    setupSplitter(workArea);
    setupVerticalSplitter(layoutEl, rowSplitter);
    onStatus(true);
  }

  function setupSplitter(split) {
    const splitter = split.querySelector('.splitter');
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault(); splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const rect = split.getBoundingClientRect();
        const width = Math.max(260, Math.min(rect.width - 300, ev.clientX - rect.left));
        split.style.setProperty('--changes-list-width', `${width}px`);
        try { localStorage.setItem('changes-list-width', String(Math.round(width))); } catch (_) { /* 保存できなくても幅は変更できる */ }
      };
      const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', end);
    });
    try {
      const saved = Number(localStorage.getItem('changes-list-width'));
      if (saved >= 260) split.style.setProperty('--changes-list-width', `${saved}px`);
    } catch (_) { /* 保存領域が使えない場合は既定幅 */ }
  }

  function setupVerticalSplitter(layout, splitter) {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault(); splitter.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const rect = layout.getBoundingClientRect();
        const height = Math.max(170, Math.min(rect.height - 170, rect.bottom - ev.clientY - 4));
        layout.style.setProperty('--commit-height', `${height}px`);
        try { localStorage.setItem('changes-commit-height', String(Math.round(height))); } catch (_) { /* 保存できなくても高さは変更できる */ }
      };
      const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', end);
    });
    try {
      const saved = Number(localStorage.getItem('changes-commit-height'));
      if (saved >= 170) layout.style.setProperty('--commit-height', `${Math.min(saved, Math.max(170, layout.clientHeight - 178))}px`);
    } catch (_) { /* 保存領域が使えない場合は既定の高さ */ }
  }

  function onStatus(first) {
    if (!listsEl || !listsEl.isConnected) return;
    const st = S.status; if (!st) return;
    // 選択中のファイルが無くなっていたら選び直す
    const still = sel && st.files.find((f) => f.path === sel.path && modeMatches(f, sel.mode));
    if (!still) sel = pickDefault(st.files);
    drawOp(); drawLists(); applyAuto(); updateCommit();
    loadDiff();
  }
  const modeMatches = (f, m) => (m === 'staged' && f.staged) || (m === 'unstaged' && f.unstaged && !f.conflict) || (m === 'conflict' && f.conflict);
  function pickDefault(files) {
    const c = files.find((f) => f.conflict); if (c) return { path: c.path, mode: 'conflict' };
    const u = files.find((f) => f.unstaged); if (u) return { path: u.path, mode: 'unstaged', untracked: u.untracked };
    const s = files.find((f) => f.staged); if (s) return { path: s.path, mode: 'staged' };
    return null;
  }

  /* ----------------- 合流などの途中状態 ----------------- */
  function drawOp() {
    clear(opEl);
    const st = S.status;
    if (!st.operation) return;
    const conflicts = st.files.filter((f) => f.conflict);
    const name = OP_NAME[st.operation] || st.operation;
    const box = h('div', { class: 'conflict-box', style: conflicts.length ? {} : { borderColor: 'var(--accent)', background: 'var(--accent-bg)' } },
      h('div', { style: { fontWeight: 700 } }, conflicts.length ? `🧩 ${name}の途中：${jp('conflict')}を解決してください` : `✅ ${name}の途中：解決済みです`),
      conflicts.length ? h('p', { class: 'muted', style: { margin: '4px 0 8px', fontSize: '12px' } }, '「自分の版」＝今の分岐の内容、「取り込む側の版」＝合流してきた側の内容です。両方を残したいときは、ファイルを開いて手で直してから「解決済みにする」を押してください。') : null,
      conflicts.map((f) => h('div', { style: { borderTop: '1px solid var(--border)', padding: '6px 0' } },
        h('div', { class: 'file-row' + (sel && sel.path === f.path ? ' selected' : ''), style: { border: 0, padding: '2px 0' }, onclick: () => select({ path: f.path, mode: 'conflict' }) }, h('span', { class: 'st U' }, 'ぶつかり'), h('span', { class: 'name' }, f.path)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => resolve(f.path, 'ours') }, '自分の版を採用'),
          h('button', { class: 'btn small', onclick: () => resolve(f.path, 'theirs') }, '取り込む側の版を採用'),
          h('button', { class: 'btn small', onclick: () => APP('openFile', S.repo, f.path).catch(showError) }, '開いて手で直す'),
          h('button', { class: 'btn small', onclick: () => resolveManual(f.path) }, '解決済みにする')))),
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary', disabled: conflicts.length > 0, onclick: finishOp }, '✔ ' + name + 'を完了する'),
        h('button', { class: 'btn danger', onclick: abortOp }, 'やめて元に戻す')));
    opEl.appendChild(box);
  }
  async function resolve(path, side) { const r = await withBusy('反映中…', () => G('resolveConflict', path, side)); if (r !== undefined) { await refreshAll(); } }
  async function resolveManual(path) {
    const ok = await confirmDialog({ title: '解決済みにしますか？', message: `「${path}」の中に <<<<<<< や >>>>>>> という印が残っていないことを確認しましたか？`, okLabel: '解決済みにする' });
    if (!ok) return;
    const r = await withBusy('反映中…', () => G('markResolved', path)); if (r !== undefined) await refreshAll();
  }
  async function finishOp() {
    const r = await withBusy('完了しています…', () => G('continueOperation'));
    if (r !== undefined) { toast('完了しました ✓'); await refreshAll(); }
  }
  async function abortOp() {
    const ok = await confirmDialog({ title: '途中でやめますか？', message: 'この操作を始める前の状態に戻します。ぶつかりの解決内容は失われます。', okLabel: 'やめて元に戻す', danger: true });
    if (!ok) return;
    const r = await withBusy('元に戻しています…', () => G('abortOperation'));
    if (r !== undefined) { toast('元に戻しました'); await refreshAll(); }
  }

  /* ----------------- ファイル一覧 ----------------- */
  function drawLists() {
    clear(listsEl);
    const files = S.status.files;
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => f.unstaged && !f.conflict);
    listsEl.appendChild(h('div', { class: 'pane-head' }, h('span', { class: 'grow' }, '✅ ', termLabel('stage', { text: '記録に含めるファイル' }), ` (${staged.length}) `, h('span', { class: 'muted', style: { fontSize: '11px', fontWeight: 400 } }, 'クリック後 Shift＋クリックで範囲選択')),
      staged.length ? [rangeSelection.staged.size ? h('button', { class: 'btn small', onclick: () => applyRange('staged'), title: '選択したファイルを記録対象から外す' }, `選択を外す (${rangeSelection.staged.size})`) : null,
        h('button', { class: 'btn small', onclick: unstageAll, title: hint('unstage') }, 'すべて外す')] : null));
    if (!staged.length) listsEl.appendChild(h('div', { class: 'empty', style: { padding: '14px' } }, '記録に含めるファイルはまだありません。'));
    staged.forEach((f) => listsEl.appendChild(fileRow(f, 'staged')));
    listsEl.appendChild(h('div', { class: 'pane-head' }, h('span', { class: 'grow' }, '✏️ まだ含めていない変更', ` (${unstaged.length}) `, h('span', { class: 'muted', style: { fontSize: '11px', fontWeight: 400 } }, 'クリック後 Shift＋クリックで範囲選択')),
      unstaged.length ? [rangeSelection.unstaged.size ? h('button', { class: 'btn small', onclick: () => applyRange('unstaged'), title: '選択したファイルを記録対象にする' }, `選択をステージ (${rangeSelection.unstaged.size})`) : null,
        h('button', { class: 'btn small', onclick: stageAll }, 'すべて含める'),
        h('button', { class: 'btn small danger', onclick: discardAll, title: hint('discard') }, 'すべて破棄')] : null));
    if (!unstaged.length) listsEl.appendChild(h('div', { class: 'empty', style: { padding: '14px' } }, staged.length ? '他に変更はありません。' : '変更されたファイルはありません。'));
    unstaged.forEach((f) => listsEl.appendChild(fileRow(f, 'unstaged')));
  }

  function fileRow(f, mode) {
    const { dir, base } = splitPath(f.path);
    const code = mode === 'staged' ? f.x : f.untracked ? '?' : f.y;
    const label = mode === 'staged' ? f.indexLabel : f.workLabel;
    const selected = sel && sel.path === f.path && sel.mode === mode;
    const rangeSelected = rangeSelection[mode] && rangeSelection[mode].has(f.path);
    const blocked = mode === 'unstaged' && !!f.tooBig;   // 100MB超：記録に含められない
    const cb = h('input', { type: 'checkbox', checked: mode === 'staged', disabled: blocked, title: blocked ? '100MBを超えるため、そのままでは含められません（右の「対処を選ぶ」から）' : mode === 'staged' ? hint('unstage') : hint('stage'),
      onclick: (e) => e.stopPropagation(), onchange: () => changeStage(f, mode) });
    const acts = h('div', { class: 'acts' });
    if (blocked) acts.appendChild(h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); bigFileDialog(f); } }, '対処を選ぶ'));
    if (mode === 'unstaged') {
      if (f.untracked) acts.appendChild(h('button', { class: 'btn small ghost', title: '管理しないファイルの一覧に追加', onclick: (e) => { e.stopPropagation(); ignoreFile(f.path); } }, '🚫'));
      acts.appendChild(h('button', { class: 'btn small ghost', title: 'ファイルを開く', onclick: (e) => { e.stopPropagation(); APP('openFile', S.repo, f.path).catch(showError); } }, '↗'));
      acts.appendChild(h('button', { class: 'btn small ghost danger', title: '変更を戻す', onclick: (e) => { e.stopPropagation(); discardOne(f); } }, '🗑'));
    }
    return h('div', { class: 'file-row' + (selected ? ' selected' : '') + (rangeSelected ? ' range-selected' : '' ) + (blocked ? ' blocked' : ''), title: blocked ? `${fmtSize(f.size)}：100MBを超えるため記録に含められません` : mode === 'unstaged' ? 'クリックで起点を設定。Shift＋クリックで範囲選択し、右クリックまたはボタンでステージします。' : f.orig ? `${f.orig} → ${f.path}` : f.path, onclick: (e) => { if (!blocked && (mode === 'staged' || mode === 'unstaged')) { if (e.shiftKey) selectRange(f, mode); else { setRangeAnchor(f, mode); rangeSelection[mode].clear(); drawLists(); } } select({ path: f.path, mode, untracked: f.untracked }); }, oncontextmenu: (e) => rowMenu(e, f, mode) },
      cb, h('span', { class: 'st ' + code }, label || '変更'),
      h('span', { class: 'name' }, h('span', { class: 'dir' }, dir), base),
      blocked ? h('span', { class: 'pill red', title: '100MBを超えるファイルはGitHubに送れません' }, `🚫 ${fmtSize(f.size)}`) : f.lfs ? h('span', { class: 'pill blue', title: 'Git LFSで管理されます' }, 'LFS') : null, acts);
  }

  /** ファイルを右クリックしたときのメニュー */
  function rowMenu(e, f, mode) {
    const gone = (mode === 'staged' ? f.x : f.y) === 'D';   // 削除されたファイルは開けない
    const items = [
      { label: '📄 ファイルを開く', disabled: gone, onclick: () => APP('openFile', S.repo, f.path).catch(showError) },
      { label: '📂 フォルダを開く', onclick: () => APP('showInFolder', S.repo, f.path).catch(showError) },
    ];
    if ((mode === 'staged' || mode === 'unstaged') && !f.tooBig) items.push('sep', { label: mode === 'staged' ? `選択した ${rangeSelection.staged.size || 1} 個をステージから外す` : `選択した ${rangeSelection.unstaged.size || 1} 個をステージ`, onclick: () => rangeSelection[mode].size ? applyRange(mode) : changeStage(f, mode) });
    if (mode === 'unstaged' && !f.conflict) items.push('sep', f.untracked
      ? { label: '🚫 管理しない一覧に追加…', onclick: () => ignoreFile(f.path) }
      : { label: '🚫 管理しない一覧に追加（記録済みのファイルは対象外）', disabled: true });
    if (f.unstaged && !f.conflict) items.push('sep', f.untracked ? { label: '🗑 削除', danger: true, onclick: () => discardOne(f) } : { label: '↩ 変更を戻す', danger: true, onclick: () => discardOne(f) });
    contextMenu(e, items);
  }

  function select(s) { sel = s; drawOp(); drawLists(); loadDiff(); }

  function selectRange(f, mode) {
    const state = rangeState[mode];
    const eligible = S.status.files.filter((x) => mode === 'staged' ? x.staged : x.unstaged && !x.conflict && !x.tooBig).map((x) => x.path);
    const from = eligible.indexOf(state.anchor), to = eligible.indexOf(f.path);
    if (from < 0 || to < 0) return;
    rangeSelection[mode] = new Set(eligible.slice(Math.min(from, to), Math.max(from, to) + 1));
  }
  async function applyRange(mode) {
    const paths = [...rangeSelection[mode]];
    if (!paths.length) return;
    const r = await G(mode === 'staged' ? 'unstage' : 'stage', paths).catch(showError);
    if (r !== undefined) { rangeSelection[mode].clear(); await refreshAll(); }
  }

  /* ----------------- 操作 ----------------- */
  async function changeStage(f, mode, useRange = false) {
    const state = rangeState[mode];
    const eligibleFiles = () => S.status.files.filter((x) => mode === 'staged' ? x.staged : x.unstaged && !x.conflict && !x.tooBig);
    if (!useRange || !state.anchor || !state.order.length) {
      setRangeAnchor(f, mode);
      const r = await G(mode === 'staged' ? 'unstage' : 'stage', [f.path]).catch(showError);
      await refreshAll();
      return r;
    }
    const targetIndex = state.order.indexOf(f.path);
    const anchorIndex = state.order.indexOf(state.anchor);
    if (targetIndex < 0 || anchorIndex < 0) return changeStage(f, mode, false);
    const from = Math.min(anchorIndex, targetIndex), to = Math.max(anchorIndex, targetIndex);
    const eligible = new Set(eligibleFiles().map((x) => x.path));
    const paths = state.order.slice(from, to + 1).filter((path) => eligible.has(path));
    const r = await G(mode === 'staged' ? 'unstage' : 'stage', paths).catch(showError);
    state.anchor = f.path;
    await refreshAll();
    return r;
  }
  function setRangeAnchor(f, mode) {
    const state = rangeState[mode];
    state.anchor = f.path;
    state.order = S.status.files.filter((x) => mode === 'staged' ? x.staged : x.unstaged && !x.conflict).map((x) => x.path);
  }
  async function stageAll() {
    const r = await G('stageAll').catch(showError); await refreshAll();
    if (r && r.skipped) toast(`100MBを超える ${r.skipped} 個のファイルは含めませんでした。右の「対処を選ぶ」から選べます。`, 'error');
  }
  const fmtSize = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';

  /** 100MBを超えるファイルの扱いを選ぶ：Git LFSで管理する／管理しない（無視リストへ） */
  async function bigFileDialog(f) {
    const body = h('div', {},
      h('p', { style: { marginTop: 0, whiteSpace: 'pre-wrap' } }, `「${f.path}」は ${fmtSize(f.size)} あり、GitHubの上限（100MB）を超えています。このままでは記録に含められません。`),
      h('p', {}, h('b', {}, '🅰 Git LFSで管理する'), h('br'), h('span', { class: 'muted' }, '大きなファイル専用の仕組みです。ファイルの本体は別の置き場に送られ、記録には小さな目印だけが入ります。（GitHubの無料枠は、保存1GB・月1GBの転送までです）')),
      h('p', {}, h('b', {}, '🅱 管理しない'), h('br'), h('span', { class: 'muted' }, 'このファイルは記録・アップロードの対象にしません。（ファイルは消えず、「管理しないファイル」の一覧に追加されます）')));
    const r = await modal({ title: '📦 大きなファイルの扱い', body, wide: true, buttons: [
      { label: 'キャンセル', value: undefined },
      { label: '🅱 管理しない', value: 'ignore' },
      { label: '🅰 Git LFSで管理する', kind: 'primary', value: 'lfs' }] });
    if (r === 'lfs') {
      const info = await G('lfsInfo').catch(() => ({ available: false }));
      if (!info.available) return confirmDialog({ title: 'Git LFS が見つかりません', message: 'Git LFS がこのパソコンにインストールされていません。\nhttps://git-lfs.com/ からインストールして、アプリを開き直してからもう一度お試しください。', okLabel: '閉じる' });
      if (await withBusy('Git LFSの設定中…', () => G('lfsTrack', f.path))) { toast('Git LFSで管理して、記録に含めました ✓'); await refreshAll(); }
    } else if (r === 'ignore') {
      if (await withBusy('追加中…', () => G('addIgnore', f.path))) { toast('管理しないファイルに追加しました'); await refreshAll(); }
    }
  }
  async function unstageAll() { await G('unstageAll').catch(showError); await refreshAll(); }

  async function discardOne(f) {
    const msg = f.untracked ? `新しいファイル「${f.path}」を削除します。元に戻せません。` : `「${f.path}」に加えた変更を捨てて、最後の記録の状態に戻します。元に戻せません。`;
    const ok = await confirmDialog({ title: f.untracked ? 'ファイルを削除しますか？' : '変更を戻しますか？', message: msg, okLabel: f.untracked ? '削除する' : '戻す', danger: true });
    if (!ok) return;
    const r = await withBusy('破棄中…', () => G('discard', [{ path: f.path, untracked: f.untracked, worktreeOnly: f.staged }]));
    if (r !== undefined) { toast(f.untracked ? '削除しました' : '変更を戻しました'); await refreshAll(); }
  }
  async function discardAll() {
    const list = S.status.files.filter((f) => f.unstaged && !f.conflict);
    const ok = await confirmDialog({ title: `${list.length} 個のファイルの変更をすべて破棄しますか？`, message: '新しいファイルは削除され、変更されたファイルは元の状態に戻ります。', note: 'この操作は元に戻せません。', okLabel: 'すべて破棄する', danger: true });
    if (!ok) return;
    const r = await withBusy('破棄中…', () => G('discard', list.map((f) => ({ path: f.path, untracked: f.untracked, worktreeOnly: f.staged }))));
    if (r !== undefined) { toast('破棄しました'); await refreshAll(); }
  }
  async function ignoreFile(p) {
    const { dir, base } = splitPath(p);
    const ext = (base.match(/\.[^./]+$/) || [''])[0];
    const opts = [{ value: '/' + p, label: `このファイルだけ（${p}）` }];
    if (ext) opts.push({ value: '*' + ext, label: `同じ種類のファイルすべて（*${ext}）` });
    if (dir) opts.push({ value: '/' + dir, label: `このフォルダごと（${dir}）` });
    opts.push({ value: '', label: '自分でパターンを書く…' });
    const r = await formDialog({
      title: '管理しないファイルに追加', okLabel: '追加する', intro: `${jp('gitignore')}に追加すると、今後このファイルは変更一覧に表示されなくなります。`,
      fields: [{ key: 'preset', label: '対象', type: 'select', value: opts[0].value, options: opts },
        { key: 'pattern', label: '「自分でパターンを書く」のときのパターン', value: '', mono: true, help: '例：*.log （すべての .log ファイル）　node_modules/ （フォルダごと）' }],
    });
    if (!r) return;
    const pattern = (r.preset || r.pattern || '').trim();
    if (!pattern) return toast('パターンを入力してください。', 'error');
    const ok = await withBusy('追加中…', () => G('addIgnore', pattern));
    if (ok) { toast(`「${pattern}」を追加しました`); await refreshAll(); }
  }

  /* ----------------- 変更内容の表示 ----------------- */
  async function loadDiff() {
    const my = ++diffToken;
    clear(diffBody);
    clear(diffHead);
    if (!sel) {
      diffHead.appendChild(h('span', { class: 'grow' }, '変更内容'));
      diffBody.appendChild(h('div', { class: 'diff-note' }, S.status.files.length ? '左のファイルを選ぶと、変更内容がここに表示されます。' : 'ファイルを編集すると、ここに変更内容が表示されます。'));
      return;
    }
    const modeLabel = sel.mode === 'staged' ? '（記録に含める予定）' : sel.mode === 'conflict' ? '（ぶつかり）' : '';
    diffHead.append(h('span', { class: 'grow' }, `📄 ${sel.path} `, h('span', { class: 'muted', style: { fontWeight: 400 } }, modeLabel)),
      h('button', { class: 'btn small', onclick: () => APP('openFile', S.repo, sel.path).catch(showError) }, 'ファイルを開く'),
      h('button', { class: 'btn small', onclick: () => APP('showInFolder', S.repo, sel.path).catch(showError) }, 'フォルダで表示'));
    const cur = S.status.files.find((x) => x.path === sel.path);
    if (cur && cur.tooBig && sel.mode === 'unstaged') {
      diffBody.appendChild(h('div', { class: 'diff-note' }, `${fmtSize(cur.size)} の大きなファイルのため、変更内容は表示しません。`, h('br'), h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => bigFileDialog(cur) }, '対処を選ぶ（Git LFS／管理しない）')));
      return;
    }
    let text;
    try { text = await G('diff', { path: sel.path, staged: sel.mode === 'staged', untracked: !!sel.untracked && sel.mode === 'unstaged' }); }
    catch (e) { if (my === diffToken) diffBody.appendChild(h('div', { class: 'diff-note' }, e.message)); return; }
    if (my !== diffToken) return;
    let actions = [];
    if (sel.mode === 'unstaged' && !sel.untracked) {
      actions = [
        { label: 'この部分だけ記録に含める', run: (p) => hunk(p, { cached: true }) },
        { label: 'この部分を破棄', danger: true, run: async (p) => { if (await confirmDialog({ title: 'この部分の変更を破棄しますか？', message: '元に戻せません。', okLabel: '破棄する', danger: true })) hunk(p, { cached: false, reverse: true }); } },
      ];
    } else if (sel.mode === 'staged') {
      actions = [{ label: 'この部分を記録から外す', run: (p) => hunk(p, { cached: true, reverse: true }) }];
    }
    diffBody.appendChild(renderDiff(text, { hunkActions: actions }));
  }
  async function hunk(patch, opts) {
    const r = await withBusy('反映中…', () => G('applyPatch', patch, opts));
    if (r !== undefined) await refreshAll();
  }

  /* ----------------- 記録する ----------------- */
  /** 変更したファイルから「記録のメモ」の下書きを入れる。本人が書き始めた（または消した）メモは上書きしない。force=true で入れ直す */
  function applyAuto(force = false) {
    if (!summaryEl || !S.status || S.status.operation) return;
    if (amendEl.checked && !force) return;
    const sug = Util.suggestMemo(S.status.files);
    const cur = summaryEl.value;
    if (!force && (draft.edited || (cur !== '' && cur !== draft.auto))) return;
    if (!sug && !force) { if (cur === draft.auto) { summaryEl.value = draft.summary = ''; draft.auto = ''; } return; }
    summaryEl.value = draft.summary = sug; draft.auto = sug; draft.edited = false;
    if (force) updateCommit();
  }
  function updateCommit() {
    if (!commitBtn) return;
    const st = S.status;
    const staged = st.files.filter((f) => f.staged).length;
    const changes = st.files.filter((f) => !f.conflict).length;
    const hasConflict = st.files.some((f) => f.conflict);
    const summary = summaryEl.value.trim();
    counterEl.textContent = `${summary.length} 文字　${summary.length > 50 ? '（50文字くらいまでだと読みやすいです）' : ''}`;
    const amend = amendEl.checked;
    clear(commitBtn);
    if (amend) commitBtn.append(h('span', { class: 'btn-label' }, '✏️ 直前の記録を修正する', termOriginal('amend')));
    else commitBtn.append(h('span', { class: 'btn-label' }, staged ? '✔ 変更を記録する' : changes ? '✔ すべての変更を記録する' : '✔ 変更を記録する', termOriginal('commit'), `${staged ? `（${staged}個のファイル）` : changes ? `（${changes}個）` : ''}`));
    commitBtn.disabled = hasConflict || !summary || (!amend && !changes) || !!st.operation;
    commitBox.hidden = !!st.operation;
    layoutEl.classList.toggle('operation', !!st.operation);
    undoBtn.hidden = !st.hasCommits || amend;
    commitPushBtn.disabled = commitBtn.disabled;
    commitPushBtn.hidden = amend;
    commitBtn.title = hasConflict ? `${jp('conflict')}を先に解決してください` : !summary ? '「記録のメモ」を入力してください' : '';
    // 自動の下書きの案内
    const sug = Util.suggestMemo(st.files);
    clear(autoEl);
    if (!amend && sug) {
      if (draft.auto && summaryEl.value === draft.auto) autoEl.append('✨ 変更したファイルから自動で入れました。自由に書き換えられます。');
      else if (summaryEl.value !== sug) autoEl.appendChild(h('button', { class: 'link', onclick: () => applyAuto(true) }, '✨ 変更したファイルから下書きを入れる'));
    }
  }

  async function onAmend() {
    draft.amend = amendEl.checked;
    if (draft.amend && !summaryEl.value.trim()) {
      const m = await G('lastCommitMessage').catch(() => null);
      if (m) { summaryEl.value = draft.summary = m.summary; bodyEl.value = draft.body = m.body; draft.edited = true; }
    }
    if (!draft.amend && !draft.edited) applyAuto();
    updateCommit();
  }

  async function doCommit(andPush) {
    const st = S.status;
    if (amendEl.checked && st.upstream && st.ahead === 0) {
      const ok = await confirmDialog({ title: 'アップロード済みの記録を修正しますか？', message: 'この記録はすでにサーバーへ送られています。修正すると、他の人の履歴とずれて、次のアップロードで問題になることがあります。', okLabel: 'それでも修正する', danger: true });
      if (!ok) return;
    }
    if (!(await ensureGitUser())) {
      toast('先に、記録に残す「名前」と「メールアドレス」を設定してください。（書いたメモはそのまま残っています）', 'error');
      return go('settings');
    }
    const staged = st.files.filter((f) => f.staged).length;
    const r = await withBusy('記録しています…', async () => {
      if (!staged && !amendEl.checked) await G('stageAll');
      return G('commit', { summary: summaryEl.value, body: bodyEl.value, amend: amendEl.checked });
    });
    if (r === undefined) return refreshAll();
    draft.summary = ''; draft.body = ''; draft.amend = false; draft.auto = ''; draft.edited = false;
    summaryEl.value = ''; bodyEl.value = ''; amendEl.checked = false;
    await refreshAll();
    toast('記録しました ✓');
    if (andPush) await doPush();
  }

  async function doUndo() {
    const st = S.status;
    const pushed = st.upstream && st.ahead === 0;
    const ok = await confirmDialog({
      title: '直前の記録を取り消しますか？', message: 'ファイルの中身はそのまま残り、「記録に含めるファイル」の状態に戻ります。メモを書き直して、もう一度記録できます。',
      note: pushed ? 'この記録はすでにアップロード済みです。取り消してからやり直すと、次のアップロードでエラーになることがあります。' : null, okLabel: '取り消す', danger: !!pushed,
    });
    if (!ok) return;
    const m = await G('lastCommitMessage').catch(() => null);
    const r = await withBusy('取り消し中…', () => G('undoLastCommit'));
    if (r !== undefined) { if (m && !summaryEl.value) { summaryEl.value = draft.summary = m.summary; bodyEl.value = draft.body = m.body; draft.edited = true; } toast('取り消しました'); await refreshAll(); }
  }

  return { render, onStatus };
})();
