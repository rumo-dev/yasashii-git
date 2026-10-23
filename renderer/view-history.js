'use strict';
/* 「履歴」画面：記録の一覧（分岐図つき）と詳細 */
Views.history = (() => {
  const PAGE = 200;
  const COLORS = ['#2563eb', '#dc2626', '#059669', '#9333ea', '#db2777', '#0891b2', '#65a30d', '#6d28d9', '#b45309', '#475569'];
  const MAIN_CANDIDATES = ['#f59e0b', '#f97316', '#14b8a6', '#ec4899', '#8b5cf6', '#84cc16', '#06b6d4', '#ef4444', '#a855f7', '#0ea5e9', '#eab308', '#10b981'];
  const ROW_H = 30, LANE_W = 14;
  let commits = [], more = false, selected = null, searchText = '', showAll = true;
  let listEl, detailEl, token = 0, colorByAuthor = {}, commitByHash = new Map(), mainHashes = new Set(), mainBranchColor = '#f59e0b';
  const avatarCache = new Map(), avatarPending = new Map();

  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  function authorKey(c) { return (c && (c.email || c.author) || 'unknown').trim().toLowerCase(); }
  function initials(name) { return Array.from(String(name || '?').trim())[0] || '?'; }
  function generatedColor(index) {
    const h = ((index * 137.508) % 360) / 60, c = 0.72, x = c * (1 - Math.abs(h % 2 - 1)), m = 0.16;
    const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return '#' + rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
  }
  function avatar(c, size = 18) {
    const key = authorKey(c);
    const color = colorByAuthor[authorKey(c)] || COLORS[0];
    const el = h('span', { class: 'author-avatar', dataset: { authorKey: key, initial: initials(c.author), fallbackColor: color }, title: `${c.author || '不明な記録者'}${c.email ? ` <${c.email}>` : ''}`, style: { width: `${size}px`, height: `${size}px`, background: color } });
    applyAvatar(el);
    return el;
  }
  function validAvatarUrl(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'avatars.githubusercontent.com'; } catch (_) { return false; }
  }
  function applyAvatar(el) {
    const key = el.dataset.authorKey;
    const url = avatarCache.get(key);
    clear(el);
    if (url && validAvatarUrl(url)) {
      el.style.background = 'transparent';
      el.appendChild(h('img', { src: url, alt: '', onerror: () => { avatarCache.set(key, ''); applyAvatar(el); } }));
    } else {
      el.style.background = el.dataset.fallbackColor;
      el.textContent = el.dataset.initial;
    }
  }
  function hydrateAvatars() {
    const repoAtStart = S.repo;
    const firstCommitByAuthor = new Map();
    for (const c of commits) if (!firstCommitByAuthor.has(authorKey(c))) firstCommitByAuthor.set(authorKey(c), c);
    for (const [key, commit] of firstCommitByAuthor) {
      if (avatarCache.has(key) || avatarPending.has(key)) continue;
      const request = GH('commitAuthorAvatar', repoAtStart, commit.hash)
        .then((url) => { avatarCache.set(key, validAvatarUrl(url) ? url : ''); })
        .catch(() => { avatarCache.set(key, ''); })
        .finally(() => {
          avatarPending.delete(key);
          if (S.repo === repoAtStart) document.querySelectorAll('.author-avatar').forEach((el) => { if (el.dataset.authorKey === key) applyAvatar(el); });
        });
      avatarPending.set(key, request);
    }
  }
  function isMainRef(r) { return (r.type === 'remote' && /\/HEAD$/i.test(r.name)) || ((r.type === 'branch' || r.type === 'remote') && /(?:^|\/)(main|master|trunk)$/i.test(r.name)); }
  function mainRef(c) { return (c.refs || []).some(isMainRef); }
  function uniqueMainColor(colors) {
    const rgb = (hex) => hex.match(/[a-f\d]{2}/ig).map((n) => parseInt(n, 16));
    const candidates = MAIN_CANDIDATES.concat(Array.from({ length: 360 }, (_, i) => generatedColor(i)));
    return candidates.map((color) => ({ color, distance: colors.length ? Math.min(...colors.map((used) => {
      const a = rgb(color), b = rgb(used); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    })) : Infinity })).sort((a, b) => b.distance - a.distance)[0].color;
  }
  function prepareColors() {
    commitByHash = new Map(commits.map((c) => [c.hash, c]));
    const keys = [...new Set(commits.map(authorKey))].sort();
    const saved = S.settings.historyAuthorColors || {};
    colorByAuthor = {};
    const used = new Set();
    keys.forEach((key) => {
      let color = /^#[0-9a-f]{6}$/i.test(saved[key] || '') ? saved[key] : '';
      if (!color) {
        let seed = 0;
        for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
        for (let offset = 0; offset < 360; offset++) {
          const candidate = generatedColor((seed + offset) % 360);
          if (!used.has(candidate)) { color = candidate; break; }
        }
      }
      colorByAuthor[key] = color; used.add(color);
    });
    mainBranchColor = uniqueMainColor(Object.values(colorByAuthor));
    mainHashes = new Set();
    for (const tip of commits.filter(mainRef)) {
      let cur = tip;
      while (cur && !mainHashes.has(cur.hash)) {
        mainHashes.add(cur.hash);
        cur = cur.parents && cur.parents[0] ? commitByHash.get(cur.parents[0]) : null;
      }
    }
  }
  function authorColorForHash(hash) {
    const c = commitByHash.get(hash);
    return c ? (colorByAuthor[authorKey(c)] || COLORS[0]) : COLORS[0];
  }
  function colorForHash(hash) {
    const c = commitByHash.get(hash);
    if (mainHashes.has(hash) || (c && mainRef(c))) return mainBranchColor;
    return authorColorForHash(hash);
  }
  function graphSvg(row, maxLanes) {
    const w = maxLanes * LANE_W + 8;
    const svg = svgEl('svg', { width: w, height: ROW_H, viewBox: `0 0 ${w} ${ROW_H}` });
    const X = (l) => l * LANE_W + 10;
    for (const e of row.edges) {
      const x1 = X(e.a), y1 = e.ay * ROW_H, x2 = X(e.b), y2 = e.by * ROW_H;
      const color = e.branch ? authorColorForHash(e.ownerHash) : colorForHash(e.ownerHash);
      const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      svg.appendChild(svgEl('path', { d, stroke: color, 'stroke-width': 2, fill: 'none' }));
    }
    const c = colorForHash(row.hash);
    svg.appendChild(svgEl('circle', { cx: X(row.lane), cy: ROW_H / 2, r: 5, fill: row.merge ? 'var(--panel)' : c, stroke: c, 'stroke-width': 2 }));
    return svg;
  }

  function render(container) {
    commits = []; selected = null;
    const search = h('input', { type: 'search', placeholder: `🔍 ${jpEn('message')}で検索`, value: searchText, style: { maxWidth: '260px' }, onchange: () => { searchText = search.value.trim(); load(true); } });
    const allChk = h('input', { type: 'checkbox', checked: showAll, onchange: () => { showAll = allChk.checked; load(true); } });
    listEl = h('div', { style: { flex: 1, overflow: 'auto' } });
    detailEl = h('div', { class: 'pane' });
    container.appendChild(h('div', { class: 'split history' },
      h('div', { class: 'pane' },
        h('div', { class: 'pane-head history-head' },
          h('div', { class: 'history-search-row' }, search, h('label', { class: 'check history-all-toggle', style: { fontWeight: 400, alignItems: 'center' } }, allChk, h('span', {}, 'すべての作業の分岐'))),
          h('div', { class: 'history-actions' },
            h('button', { class: 'btn small', title: '履歴に表示する記録者ごとの色を設定', onclick: configureAuthorColors }, '🎨 記録者の色'),
            h('button', { class: 'btn small', onclick: recoverReflog }, '🛟 消えた記録を探す'),
            h('button', { class: 'btn small', title: '履歴を更新', onclick: () => load(true) }, '🔄'))),
        listEl),
      detailEl));
    load(true);
  }
  function onStatus() { if (listEl && listEl.isConnected) load(true, true); }

  async function recoverReflog() {
    let entries;
    try { entries = await G('reflog', { limit: 100 }); } catch (e) { await showError(e); return; }
    if (!entries.length) { toast('復旧できる記録が見つかりません。', 'error'); return; }
    const chosen = await formDialog({ title: '消えた記録・分岐を探す', okLabel: '救出用の分岐を作る', wide: true,
      intro: 'Gitの移動履歴に残っている記録から、新しい分岐を作って復旧します。元の履歴は変更しません。',
      fields: [
        { key: 'entry', label: '復旧する記録', type: 'select', value: entries[0].hash, options: entries.map((x) => ({ value: x.hash, label: `${x.selector}　${x.subject}　(${x.short})` })) },
        { key: 'name', label: '救出用の分岐名', value: `recovery/${new Date().toISOString().slice(0, 10)}`, required: true, placeholder: '例：recovery/作業の復旧' },
      ] });
    if (!chosen) return;
    const ok = await withBusy('記録を救出中…', () => G('recoverFromReflog', chosen.entry, chosen.name));
    if (ok) { toast(`「${chosen.name}」を作って復旧しました ✓`); await refreshAll(); go('branches', true); }
  }

  async function configureAuthorColors() {
    let rows;
    try { rows = await G('log', { limit: 500, all: true }); } catch (e) { await showError(e); return; }
    const people = [...new Map(rows.map((c) => [authorKey(c), c])).values()].sort((a, b) => a.author.localeCompare(b.author));
    if (!people.length) { toast('色を設定できる記録者がいません。', 'error'); return; }
    const next = { ...(S.settings.historyAuthorColors || {}) };
    const inputs = people.map((person, i) => {
      const key = authorKey(person);
      const color = colorByAuthor[key] || COLORS[i % COLORS.length];
      if (!next[key]) next[key] = color;
      const picker = h('input', { type: 'color', value: color, title: `${person.author}の色`, style: { width: '48px', height: '34px', padding: '2px', cursor: 'pointer' }, oninput: () => { next[key] = picker.value; } });
      return { person, picker };
    });
    const body = h('div', {},
      h('p', { class: 'muted', style: { marginTop: 0 } }, '履歴の記録者アイコンと枝の色を設定します。同じ記録者の作業分岐は同じ色系統で表示されます。メイン分岐の色は、記録者の色と重ならないよう自動で選びます。'),
      h('div', { class: 'list', style: { maxHeight: '50vh', overflow: 'auto' } }, inputs.map(({ person, picker }) =>
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } }, avatar(person), h('div', { class: 'grow' }, h('b', {}, person.author), h('div', { class: 'muted mono', style: { fontSize: '11px', overflowWrap: 'anywhere' } }, person.email))), picker))));
    const answer = await modal({ title: '記録者ごとの表示色', body, buttons: [
      { label: 'キャンセル', value: false },
      { label: '色を保存', kind: 'primary', value: true, validate: () => {
        const colors = inputs.map(({ picker }) => picker.value.toLowerCase());
        return new Set(colors).size === colors.length ? null : '記録者ごとに異なる色を選んでください。';
      } },
    ] });
    if (!answer) return;
    inputs.forEach(({ person, picker }) => { next[authorKey(person)] = picker.value; });
    await saveSettings({ historyAuthorColors: next });
    prepareColors(); draw();
    if (selected) showDetail(selected);
    toast('記録者の表示色を保存しました ✓');
  }

  async function load(reset, keepSel) {
    const my = ++token;
    const skip = reset ? 0 : commits.length;
    let rows;
    try { rows = await G('log', { limit: PAGE, skip, all: showAll, search: searchText }); }
    catch (e) { clear(listEl).appendChild(h('div', { class: 'empty' }, e.message)); return; }
    if (my !== token) return;
    commits = reset ? rows : commits.concat(rows);
    prepareColors();
    more = rows.length === PAGE;
    if (reset && !keepSel) selected = commits[0] || null;
    else if (selected) selected = commits.find((c) => c.hash === selected.hash) || commits[0] || null;
    draw();
    hydrateAvatars();
    if (!keepSel || !detailEl.firstChild) showDetail(selected);
  }

  function draw() {
    clear(listEl);
    if (!commits.length) { listEl.appendChild(h('div', { class: 'empty' }, searchText ? '一致する記録はありません。' : 'まだ記録がありません。「変更」画面から最初の記録を作りましょう。')); return; }
    const useGraph = !searchText;
    const g = useGraph ? layoutGraph(commits) : null;
    commits.forEach((c, i) => {
      const badges = c.refs.map((r) => {
        const isMain = isMainRef(r);
        return h('span', { class: 'ref ' + r.type, title: r.type === 'remote' ? 'サーバー上の分岐' : r.type === 'tag' ? jp('tag') : jp('branch'), style: isMain ? { background: mainBranchColor, color: '#fff' } : null }, (r.type === 'tag' ? '🏷 ' : '') + r.name);
      });
      listEl.appendChild(h('div', { class: 'commit-row' + (selected && selected.hash === c.hash ? ' selected' : ''), onclick: () => { selected = c; draw(); showDetail(c); } },
        g ? graphSvg(g.rows[i], g.maxLanes) : h('span', { style: { width: '10px' } }),
        avatar(c),
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
    const btn = (label, fn, danger) => h('button', { class: 'btn small' + (danger ? ' danger' : ''), onclick: fn }, h('span', { class: 'btn-label' }, label));
    detailEl.append(
      h('div', { class: 'detail-head' },
        h('h3', {}, c.subject),
        c.body ? h('div', { class: 'detail-body' }, c.body) : null,
        h('div', { class: 'muted author-detail' }, avatar(c, 20), h('span', {}, `${c.author} <${c.email}>　🕒 ${fullTime(c.date)}`)),
        h('div', { class: 'muted mono', style: { fontSize: '12px', margin: '4px 0 8px' } }, `ID: ${c.short}` + (c.parents.length > 1 ? `　（${jp('merge')}の記録）` : '')),
        h('div', { class: 'btn-row' },
          btn(['↩ 取り消しの記録を作る', termOriginal('revert')], () => doRevert(c)),
          btn(['📋 この記録をコピー', termOriginal('cherryPick')], () => doCherry(c)),
          btn(['🌿 ここから新しい分岐を作る', termOriginal('branch')], () => doBranch(c)),
          btn(['🏷 目印をつける', termOriginal('tag')], () => doTag(c)),
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
