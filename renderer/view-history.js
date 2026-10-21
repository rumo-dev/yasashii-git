'use strict';
/* 「履歴」画面：記録の一覧（分岐図つき）と詳細 */
Views.history = (() => {
  const PAGE = 200;
  const COLORS = ['#2f7d5b', '#1f6feb', '#c0392b', '#9a6700', '#8250df', '#0e8a9a', '#d4537e', '#5a6b7a'];
  const ROW_H = 30, LANE_W = 14;
  let commits = [], more = false, selected = null, searchText = '', showAll = true;
  let listEl, detailEl, token = 0;

  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  function graphSvg(row, maxLanes) {
    const w = maxLanes * LANE_W + 8;
    const svg = svgEl('svg', { width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}` });
    const X = (l) => l * LANE_W + 10;
    for (const e of row.edges) {
      const x1 = X(e.a), y1 = e.ay * ROW_H, x2 = X(e.b), y2 = e.by * ROW_H;
      const color = COLORS[(e.a === row.lane && e.ay === 0.5 ? e.b : Math.max(e.a, e.b)) % COLORS.length];
      const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      svg.appendChild(svgEl('path', { d, stroke: color, 'stroke-width': 2, fill: 'none' }));
    }
    const c = COLORS[row.lane % COLORS.length];
    svg.appendChild(svgEl('circle', { cx: X(row.lane), cy: ROW_H / 2, r: 5, fill: row.merge ? 'var(--panel)' : c, stroke: c, 'stroke-width': 2 }));
    return svg;
  }

  function render(container) {
    commits = []; selected = null;
    const search = h('input', { type: 'search', placeholder: '🔍 記録のメモで検索', value: searchText, style: { maxWidth: '260px' }, onchange: () => { searchText = search.value.trim(); load(true); } });
    const allChk = h('input', { type: 'checkbox', checked: showAll, onchange: () => { showAll = allChk.checked; load(true); } });
    listEl = h('div', { style: { flex: 1, overflow: 'auto' } });
    detailEl = h('div', { class: 'pane' });
    container.appendChild(h('div', { class: 'split history' },
      h('div', { class: 'pane' },
        h('div', { class: 'pane-head' }, search, h('label', { class: 'check', style: { fontWeight: 400, alignItems: 'center' } }, allChk, h('span', {}, 'すべての作業の分岐')), h('span', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: () => load(true) }, '🔄')),
        listEl),
      detailEl));
    load(true);
  }
  function onStatus() { if (listEl && listEl.isConnected) load(true, true); }

  async function load(reset, keepSel) {
    const my = ++token;
    const skip = reset ? 0 : commits.length;
    let rows;
    try { rows = await G('log', { limit: PAGE, skip, all: showAll, search: searchText }); }
    catch (e) { clear(listEl).appendChild(h('div', { class: 'empty' }, e.message)); return; }
    if (my !== token) return;
    commits = reset ? rows : commits.concat(rows);
    more = rows.length === PAGE;
    if (reset && !keepSel) selected = commits[0] || null;
    else if (selected) selected = commits.find((c) => c.hash === selected.hash) || commits[0] || null;
    draw();
    if (!keepSel || !detailEl.firstChild) showDetail(selected);
  }

  function draw() {
    clear(listEl);
    if (!commits.length) { listEl.appendChild(h('div', { class: 'empty' }, searchText ? '一致する記録はありません。' : 'まだ記録がありません。「変更」画面から最初の記録を作りましょう。')); return; }
    const useGraph = !searchText;
    const g = useGraph ? layoutGraph(commits) : null;
    commits.forEach((c, i) => {
      const badges = c.refs.map((r) => h('span', { class: 'ref ' + r.type, title: r.type === 'remote' ? 'サーバー上の分岐' : r.type === 'tag' ? jp('tag') : jp('branch') }, (r.type === 'tag' ? '🏷 ' : '') + r.name));
      listEl.appendChild(h('div', { class: 'commit-row' + (selected && selected.hash === c.hash ? ' selected' : ''), onclick: () => { selected = c; draw(); showDetail(c); } },
        g ? graphSvg(g.rows[i], g.maxLanes) : h('span', { style: { width: '10px' } }),
        h('div', { class: 'msg', title: c.subject }, badges, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, c.subject)),
        h('div', { class: 'who' }, c.author), h('div', { class: 'when', title: fullTime(c.date) }, relTime(c.date))));
    });
    if (more) listEl.appendChild(h('div', { style: { padding: '10px', textAlign: 'center' } }, h('button', { class: 'btn', onclick: () => load(false, true) }, 'さらに読み込む')));
  }

  /* ------------------- 詳細 ------------------- */
  async function showDetail(c) {
    clear(detailEl);
    if (!c) { detailEl.appendChild(h('div', { class: 'diff-note' }, '記録を選ぶと詳細が表示されます。')); return; }
    const fileList = h('div', { style: { maxHeight: '180px', overflow: 'auto', borderBottom: '1px solid var(--border)' } });
    const diffArea = h('div', { style: { flex: 1, overflow: 'auto' } });
    const btn = (label, fn, danger) => h('button', { class: 'btn small' + (danger ? ' danger' : ''), onclick: fn }, label);
    detailEl.append(
      h('div', { class: 'detail-head' },
        h('h3', {}, c.subject),
        c.body ? h('div', { class: 'detail-body' }, c.body) : null,
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${c.author} <${c.email}>　🕒 ${fullTime(c.date)}`),
        h('div', { class: 'muted mono', style: { fontSize: '12px', margin: '4px 0 8px' } }, `ID: ${c.short}` + (c.parents.length > 1 ? `　（${jp('merge')}の記録）` : '')),
        h('div', { class: 'btn-row' },
          btn('↩ ' + jp('revert'), () => doRevert(c)),
          btn('📋 ' + jp('cherryPick'), () => doCherry(c)),
          btn('🌿 ここから新しい分岐を作る', () => doBranch(c)),
          btn('🏷 目印をつける', () => doTag(c)),
          btn('👁 この時点を見る', () => doView(c)),
          btn('⏪ ' + jp('reset') + '…', () => doReset(c), true),
          btn('コピー', async () => { await APP('copyText', c.hash); toast('記録のIDをコピーしました'); }))),
      fileList, diffArea);
    let files = [];
    try { files = await G('commitFiles', c.hash); } catch (e) { fileList.appendChild(h('div', { class: 'empty' }, e.message)); return; }
    if (selected !== c) return;
    if (!files.length) { fileList.appendChild(h('div', { class: 'empty', style: { padding: '12px' } }, 'ファイルの変更はありません。')); return; }
    const showFile = async (f, row) => {
      fileList.querySelectorAll('.file-row').forEach((r) => r.classList.remove('selected')); row.classList.add('selected');
      clear(diffArea);
      try { diffArea.appendChild(renderDiff(await G('commitDiff', c.hash, f.path))); } catch (e) { diffArea.appendChild(h('div', { class: 'diff-note' }, e.message)); }
    };
    files.forEach((f, i) => {
      const { dir, base } = splitPath(f.path);
      const row = h('div', { class: 'file-row', onclick: () => showFile(f, row) }, h('span', { class: 'st ' + f.status }, f.label), h('span', { class: 'name' }, h('span', { class: 'dir' }, dir), base));
      fileList.appendChild(row);
      if (i === 0) showFile(f, row);
    });
  }

  /* ------------------- 操作 ------------------- */
  async function after(r, msg) {
    if (r === undefined) return refreshAll();
    const conflict = await afterConflictCheck(r, msg);
    if (!conflict) load(true);
  }
  async function doRevert(c) {
    const ok = await confirmDialog({ title: '取り消しの記録を作りますか？', message: `「${c.subject}」の変更を打ち消す、新しい記録を作ります。\n\n過去の履歴は消えないので安全です。`, okLabel: '取り消しの記録を作る' });
    if (!ok) return;
    after(await withBusy('作成中…', () => G('revertCommit', c.hash)), '取り消しの記録を作りました ✓');
  }
  async function doCherry(c) {
    const ok = await confirmDialog({ title: 'この記録を今の分岐にコピーしますか？', message: `「${c.subject}」の変更だけを、今の作業の分岐に取り込みます。`, okLabel: 'コピーする' });
    if (!ok) return;
    after(await withBusy('コピー中…', () => G('cherryPick', c.hash)), 'コピーしました ✓');
  }
  async function doBranch(c) {
    const name = await promptDialog({ title: 'この記録から新しい作業の分岐を作る', label: '新しい分岐の名前', placeholder: '例：fix-header', help: '半角英数字とハイフンがおすすめです。作成後、その分岐に切り替わります。', okLabel: '作成して切り替える' });
    if (!name) return;
    after(await withBusy('作成中…', () => G('createBranch', name, { from: c.hash })), `分岐「${name}」を作りました ✓`);
  }
  async function doTag(c) {
    const r = await formDialog({ title: 'この記録に目印をつける', okLabel: '目印をつける', fields: [
      { key: 'name', label: '目印の名前', placeholder: '例：v1.0.0', required: true },
      { key: 'message', label: '説明（省略できます）', placeholder: '例：最初の公開バージョン', help: '説明を書くと、より正式な目印になります。' }] });
    if (!r) return;
    after(await withBusy('作成中…', () => G('createTag', r.name, { hash: c.hash, message: r.message })), '目印をつけました ✓');
  }
  async function doView(c) {
    const ok = await confirmDialog({ title: 'この時点の状態を見ますか？', message: `ファイルの中身が「${c.subject}」の時点の状態になります。\nこの状態で記録を作ると迷子になりやすいので、見終わったら「作業の分岐」画面で分岐に戻ってください。`, okLabel: 'この時点を見る' });
    if (!ok) return;
    after(await withBusy('切り替え中…', () => G('switchToCommit', c.hash)), '過去の状態を表示しています');
  }
  async function doReset(c) {
    const r = await formDialog({ title: `${jp('reset')}`, okLabel: '巻き戻す', danger: true,
      intro: `作業中の分岐の先頭を「${c.subject}」（${c.short}）の位置まで戻します。\nそれより新しい記録は、分岐からは見えなくなります。`,
      fields: [{ key: 'mode', label: '今の変更の扱い', type: 'select', value: 'keep', options: [
        { value: 'keep', label: 'ファイルの変更は残す（おすすめ）' }, { value: 'staged', label: '新しい記録の内容を「記録に含める」状態で残す' }, { value: 'discard', label: '変更もすべて消す（危険・元に戻せません）' }] }] });
    if (!r) return;
    if (r.mode === 'discard') {
      const ok = await confirmDialog({ title: '本当に変更を消しますか？', message: 'まだ記録していない変更も含めて、すべて失われます。', note: '元に戻せません。', okLabel: '消して巻き戻す', danger: true });
      if (!ok) return;
    }
    after(await withBusy('巻き戻し中…', () => G('resetTo', c.hash, r.mode)), '巻き戻しました ✓');
  }

  return { render, onStatus };
})();
