'use strict';
/* 「一時退避」画面と「目印」画面 */
Views.stash = (() => {
  let root, sel = null, token = 0;
  function render(container) { root = container; draw(); }
  function onStatus() { /* 一覧は操作時のみ更新（入力中の再描画を避ける） */ }

  async function draw() {
    const my = ++token;
    let list;
    try { list = await G('stashList'); } catch (e) { clear(root).appendChild(h('div', { class: 'pad' }, e.message)); return; }
    if (my !== token) return;
    if (!list.find((s) => s.ref === sel)) sel = list[0] ? list[0].ref : null;
    const diffEl = h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } });
    clear(root).appendChild(h('div', { class: 'pad' },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } },
        h('div', { style: { flex: 1 } }, h('h2', {}, '📦 ', termLabel('stash')), h('p', { class: 'sub' }, hint('stash') + ' 急に別の作業をしたいときに便利です。')),
        h('button', { class: 'btn primary', onclick: save }, '＋ 今の変更をしまう')),
      h('div', { class: 'list', style: { marginBottom: '16px' } }, list.length ? list.map((s) => h('div', { class: 'row clickable' + (sel === s.ref ? ' selected' : ''), onclick: () => { sel = s.ref; draw(); } },
        h('span', {}, '📦'), h('div', { class: 'grow' }, h('div', { class: 'title' }, s.subject), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${s.ref}　${fullTime(s.date)}`)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', title: '変更を元に戻して、しまっておいた内容を削除します', onclick: (e) => { e.stopPropagation(); act('stashPop', s, '戻しました ✓'); } }, '戻す'),
          h('button', { class: 'btn small', title: '変更を元に戻しますが、しまった内容も残します', onclick: (e) => { e.stopPropagation(); act('stashApply', s, '戻しました（退避は残っています）'); } }, 'コピーして戻す'),
          h('button', { class: 'btn small danger', onclick: (e) => { e.stopPropagation(); drop(s); } }, '削除')))) : h('div', { class: 'empty' }, 'しまってある変更はありません。')),
      list.length ? [h('h3', {}, '内容'), diffEl] : null));
    if (sel) { try { clear(diffEl).appendChild(renderDiff(await G('stashDiff', sel))); } catch (e) { diffEl.textContent = e.message; } }
  }
  async function save() {
    const n = S.status.files.length;
    if (!n) { toast('しまう変更がありません'); return; }
    const r = await formDialog({ title: '今の変更を一時退避する', okLabel: 'しまう', intro: `${n} 個のファイルの変更を脇へしまい、ファイルを最後の記録の状態に戻します。`, fields: [
      { key: 'message', label: 'メモ（省略できます）', placeholder: '例：ログイン画面の途中' },
      { key: 'untracked', label: '新しいファイルも一緒にしまう', type: 'checkbox', value: true }] });
    if (!r) return;
    const ok = await withBusy('しまっています…', () => G('stashSave', { message: r.message, includeUntracked: r.untracked }));
    if (ok) { toast('しまいました ✓'); await refreshAll(); draw(); }
  }
  async function act(fn, s, msg) {
    const res = await withBusy('戻しています…', () => G(fn, s.ref));
    if (res === undefined) return refreshAll();
    const conflict = await afterConflictCheck(res, msg);
    if (!conflict) draw();
  }
  async function drop(s) {
    const ok = await confirmDialog({ title: 'しまった変更を削除しますか？', message: `「${s.subject}」を完全に削除します。`, note: '元に戻せません。', okLabel: '削除する', danger: true });
    if (!ok) return;
    const r = await withBusy('削除中…', () => G('stashDrop', s.ref));
    if (r !== undefined) { toast('削除しました'); draw(); }
  }
  return { render, onStatus };
})();

Views.tags = (() => {
  let root, token = 0;
  function render(container) { root = container; draw(); }
  function onStatus() {}

  async function remoteName() {
    const rs = await G('remotes');
    if (!rs.length) throw new Error('接続先（GitHubなど）が設定されていません。「設定」画面で追加してください。');
    return (rs.find((r) => r.name === 'origin') || rs[0]).name;
  }

  async function draw() {
    const my = ++token;
    let list;
    try { list = await G('tags'); } catch (e) { clear(root).appendChild(h('div', { class: 'pad' }, e.message)); return; }
    if (my !== token) return;
    clear(root).appendChild(h('div', { class: 'pad' },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } },
        h('div', { style: { flex: 1 } }, h('h2', {}, '🏷️ ', termLabel('tag')), h('p', { class: 'sub' }, hint('tag') + ' 作った目印は「アップロード」するとGitHubでも見られます。')),
        h('button', { class: 'btn primary', onclick: create }, '＋ 目印をつける')),
      h('div', { class: 'list' }, list.length ? list.map((t) => h('div', { class: 'row' },
        h('span', {}, '🏷️'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, t.name), ' ', h('span', { class: 'pill', title: t.annotated ? '説明つきの目印' : '名前だけの目印' }, t.annotated ? '説明つき' : '名前のみ')),
          h('div', { class: 'muted title', style: { fontSize: '12px' } }, `${t.sha}　${t.annotated && t.subject ? t.subject + '　' : ''}${fullTime(t.date)}`)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', title: 'この目印をバージョン名にして、GitHubにリリースを作ります', onclick: () => releaseFlow({ tag: t.name }) }, '🚀 リリースにする'),
          h('button', { class: 'btn small', onclick: () => push(t) }, '⬆ アップロード'),
          h('button', { class: 'btn small danger', onclick: () => del(t, false) }, '削除'),
          h('button', { class: 'btn small danger', onclick: () => del(t, true) }, 'サーバーからも削除')))) : h('div', { class: 'empty' }, 'まだ目印はありません。バージョンの区切りなどにつけておくと便利です。'))));
  }
  async function create() {
    const r = await formDialog({ title: '最新の記録に目印をつける', okLabel: '目印をつける', fields: [
      { key: 'name', label: '目印の名前', placeholder: '例：v1.0.0', required: true },
      { key: 'message', label: '説明（省略できます）', placeholder: '例：最初の公開バージョン' }] });
    if (!r) return;
    const ok = await withBusy('作成中…', () => G('createTag', r.name, { message: r.message }));
    if (ok) { toast('目印をつけました ✓'); draw(); }
  }
  async function push(t) {
    const r = await withBusy('アップロード中…', async () => G('pushTag', t.name, await remoteName()));
    if (r !== undefined) toast('アップロードしました 🎉');
  }
  async function del(t, remote) {
    const ok = await confirmDialog({ title: `目印「${t.name}」を削除しますか？`, message: remote ? 'この端末とサーバーの両方から削除します。' : 'この端末の目印だけを削除します。（記録そのものは消えません）', okLabel: '削除する', danger: true });
    if (!ok) return;
    const r = await withBusy('削除中…', async () => { await G('deleteTag', t.name); if (remote) await G('deleteRemoteTag', t.name, await remoteName()); return true; });
    if (r) { toast('削除しました'); draw(); }
  }
  return { render, onStatus };
})();
