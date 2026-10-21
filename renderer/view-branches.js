'use strict';
/* 「作業の分岐」画面 */
Views.branches = (() => {
  let root, data = null, token = 0;
  const open = { local: true, remote: false };   // 折りたたみの状態（手元は開く／サーバーは閉じる）

  function render(container) { root = container; draw(true); }
  function onStatus() { if (root && root.isConnected) draw(false); }

  async function draw(showLoading) {
    const my = ++token;
    let d;
    try { d = await G('branches'); } catch (e) { if (my === token) { clear(root).appendChild(h('div', { class: 'pad' }, e.message)); } return; }
    if (my !== token) return;
    data = d;
    const st = S.status;
    clear(root);
    root.appendChild(h('div', { class: 'pad' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
        h('div', { style: { flex: 1 } }, h('h2', {}, '🌿 ', termLabel('branch')), h('p', { class: 'sub' }, hint('branch') + ' 新しい機能や修正は、専用の分岐で進めると安心です。')),
        h('button', { class: 'btn primary', onclick: createBranch }, '＋ 新しい作業の分岐を作る')),
      st.detached ? h('div', { class: 'card', style: { background: 'var(--warn-bg)', color: 'var(--warn)' } }, `⚠ いまは${jp('detached')}です。${hint('detached')}`) : null,
      section('local', '🌿 手元の分岐', d.local.length,
        d.local.length ? d.local.map(localRow) : h('div', { class: 'empty' }, 'まだ分岐がありません。最初の記録を作ると「main」などの分岐ができます。')),
      section('remote', '☁️ サーバー（GitHubなど）上の分岐', d.remote.length,
        d.remote.length ? d.remote.map(remoteRow) : h('div', { class: 'empty' }, 'サーバー上の分岐はありません。「更新を確認」を押すと最新の情報を取得できます。'))));
  }

  /** 折りたたみできる一覧。開閉の状態は画面を更新しても保たれる */
  function section(key, title, count, rows) {
    const list = h('div', { class: 'list', style: { marginBottom: '20px' }, hidden: !open[key] }, rows);
    const arrow = h('span', { class: 'fold-arrow' }, open[key] ? '▼' : '▶');
    const head = h('button', { class: 'fold-head', 'aria-expanded': String(open[key]), onclick: () => {
      open[key] = !open[key]; list.hidden = !open[key]; arrow.textContent = open[key] ? '▼' : '▶'; head.setAttribute('aria-expanded', String(open[key]));
    } }, arrow, h('span', {}, title), h('span', { class: 'pill' }, String(count)));
    return h('div', {}, head, list);
  }

  function syncText(b) {
    if (b.gone) return h('span', { class: 'pill red' }, 'サーバー側では削除済み');
    if (!b.upstream) return h('span', { class: 'pill yellow', title: '一度「アップロード」すると、サーバーと結びつきます' }, '未アップロード');
    const parts = [];
    if (b.ahead) parts.push(h('span', { class: 'pill green' }, `↑ ${b.ahead}件 アップロード待ち`));
    if (b.behind) parts.push(h('span', { class: 'pill blue' }, `↓ ${b.behind}件 取り込み待ち`));
    return parts.length ? parts : h('span', { class: 'pill' }, '✓ サーバーと同じ');
  }

  function localRow(b) {
    const acts = h('div', { class: 'btn-row' });
    if (!b.current) {
      acts.append(
        h('button', { class: 'btn small', onclick: () => switchTo(b.name) }, '切り替え'),
        h('button', { class: 'btn small', title: hint('merge'), onclick: () => mergeInto(b.name) }, '今の分岐に合流'));
    }
    acts.append(h('button', { class: 'btn small', onclick: () => rename(b.name) }, '名前変更'));
    if (b.current && b.upstream) acts.append(h('button', { class: 'btn small danger', title: hint('force'), onclick: forcePush }, jp('force')));
    if (!b.current) acts.append(h('button', { class: 'btn small danger', onclick: () => del(b.name) }, '削除'));
    return h('div', { class: 'row' },
      h('span', {}, b.current ? '📍' : '🌿'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, b.name), ' ', b.current ? h('span', { class: 'pill green' }, '今ここで作業中') : null),
        h('div', { class: 'muted title', style: { fontSize: '12px' } }, `${b.sha} ${b.subject}`),
        h('div', { style: { marginTop: '2px', display: 'flex', gap: '4px', flexWrap: 'wrap' } }, syncText(b))),
      acts);
  }

  function remoteRow(b) {
    const remote = b.name.split('/')[0];
    const short = b.name.slice(remote.length + 1);
    const haveLocal = data.local.some((l) => l.name === short);
    return h('div', { class: 'row' },
      h('span', {}, '☁️'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, b.name)), h('div', { class: 'muted title', style: { fontSize: '12px' } }, `${b.sha} ${b.subject}`)),
      h('div', { class: 'btn-row' },
        haveLocal ? h('span', { class: 'pill' }, '手元にもあります') : h('button', { class: 'btn small', onclick: () => checkoutRemote(b.name) }, '手元に持ってきて切り替え'),
        h('button', { class: 'btn small', title: 'この分岐の内容を今の分岐に取り込みます', onclick: () => mergeInto(b.name) }, '今の分岐に合流'),
        h('button', { class: 'btn small danger', onclick: () => delRemote(remote, short) }, 'サーバーから削除')));
  }

  /* ------------------- 操作 ------------------- */
  async function createBranch() {
    const cur = S.status.branch;
    const r = await formDialog({ title: '新しい作業の分岐を作る', okLabel: '作成する',
      intro: cur ? `いまの分岐「${cur}」の状態から、新しい分岐を作ります。` : '新しい分岐を作ります。',
      fields: [
        { key: 'name', label: '分岐の名前', placeholder: '例：feature-login', required: true, help: '半角英数字とハイフンがおすすめです（日本語や空白は避けましょう）。' },
        { key: 'sw', label: '作ったあと、その分岐に切り替える', type: 'checkbox', value: true }] });
    if (!r) return;
    const ok = await withBusy('作成中…', () => G('createBranch', r.name.trim(), { switchTo: r.sw }));
    if (ok) { toast(`分岐「${r.name.trim()}」を作りました ✓`); await refreshAll(); }
  }
  async function switchTo(name) {
    const ok = await withBusy('切り替え中…', () => G('switchBranch', name));
    if (ok) { toast(`「${name}」に切り替えました`); await refreshAll(); }
  }
  async function checkoutRemote(name) {
    const ok = await withBusy('切り替え中…', () => G('switchBranch', name, { remote: true }));
    if (ok) { toast('手元に持ってきて切り替えました'); await refreshAll(); }
  }
  async function mergeInto(name) {
    const cur = S.status.branch || '今の場所';
    const r = await formDialog({ title: `${jp('merge')}する`, okLabel: '合流する',
      intro: `「${name}」の作業内容を、いまの分岐「${cur}」に取り込みます。\n同じ場所を別々に変更していた場合は、どちらを採用するか選ぶ画面になります。`,
      fields: [{ key: 'noff', label: '合流した記録を必ず残す', type: 'checkbox', value: false, help: '履歴に「ここで合流した」という記録が残り、あとから分かりやすくなります。' }] });
    if (!r) return;
    const res = await withBusy('合流中…', () => G('merge', name, { noFastForward: r.noff }));
    if (res === undefined) return refreshAll();
    await afterConflictCheck(res, res.upToDate ? 'すでに取り込み済みです' : '合流しました ✓');
  }
  async function rename(name) {
    const nn = await promptDialog({ title: '分岐の名前を変更', label: '新しい名前', value: name, okLabel: '変更する' });
    if (!nn || nn === name) return;
    const ok = await withBusy('変更中…', () => G('renameBranch', name, nn));
    if (ok) { toast('名前を変更しました ✓'); await refreshAll(); }
  }
  async function del(name) {
    const ok = await confirmDialog({ title: `分岐「${name}」を削除しますか？`, message: '手元の分岐だけが消えます（サーバー上の分岐は残ります）。', okLabel: '削除する', danger: true });
    if (!ok) return;
    busyOn('削除中…');
    try { await G('deleteBranch', name); toast('削除しました'); }
    catch (e) {
      busyOff();
      if (/合流していない/.test(e.message)) {
        const f = await confirmDialog({ title: 'まだ合流していない作業があります', message: e.message, note: '強制的に削除すると、その作業内容は失われます。', okLabel: '強制的に削除する', danger: true });
        if (f) { const r = await withBusy('削除中…', () => G('deleteBranch', name, { force: true })); if (r !== undefined) toast('削除しました'); }
      } else await showError(e);
      busyOn('');
    } finally { busyOff(); }
    await refreshAll();
  }
  async function delRemote(remote, name) {
    const ok = await confirmDialog({ title: `サーバー上の分岐「${name}」を削除しますか？`, message: 'GitHubなどのサーバーから、この分岐を削除します。他の人も影響を受けます。', note: '元に戻せません。', okLabel: 'サーバーから削除する', danger: true });
    if (!ok) return;
    const r = await withBusy('削除中…', () => G('deleteRemoteBranch', remote, name));
    if (r !== undefined) { toast('削除しました'); await refreshAll(); }
  }
  async function forcePush() {
    const ok = await confirmDialog({ title: `${jp('force')}しますか？`, message: `${hint('force')}\n\n「記録を修正した」「巻き戻した」あとに、サーバーの履歴をそろえたい場合にだけ使います。`, note: '他の人の更新が消える可能性があります。迷ったら「キャンセル」してください。', okLabel: '強制アップロードする', danger: true });
    if (!ok) return;
    if (!(await safetyGate())) return;
    const r = await withBusy('アップロード中…', () => G('push', { force: true }));
    if (r !== undefined) { toast('アップロードしました'); await refreshAll(); }
  }

  return { render, onStatus };
})();
