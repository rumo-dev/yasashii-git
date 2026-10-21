'use strict';
/* 「受信箱」画面：招待・変更の提案（プルリクエスト）・課題（Issue）などの通知をまとめて見る。手動で「確認」もできる */

const NOTE_REASON = {
  review_requested: ['レビューの依頼', 'yellow'], mention: ['あなたへのメンション', 'blue'], team_mention: ['チームへのメンション', 'blue'], assign: ['担当に指定', 'yellow'],
  author: ['あなたの投稿に動きがありました', ''], comment: ['新しいコメント', ''], state_change: ['状態が変わりました', ''], subscribed: ['ウォッチ中', ''],
  review_requested_by_team: ['チームへのレビュー依頼', 'yellow'], ci_activity: ['自動チェックの結果', ''], security_alert: ['セキュリティの警告', 'red'], invitation: ['招待', 'green'],
};
const noteReason = (r) => NOTE_REASON[r] || ['お知らせ', ''];
const NOTE_ICON = { pr: '🔀', issue: '📋', other: '🔔' };

/** 受信箱の件数（招待＋未読の通知）を調べて、画面の印に反映する。件数を返す */
async function refreshInboxCount() {
  const [inv] = await Promise.all([refreshInviteCount(), GH('myNotifications').then((n) => { S.notes = n; }).catch(() => { S.notes = S.notes || []; })]);
  S.inboxCount = (inv || 0) + (S.notes || []).length;
  const c = document.querySelector('.nav-item[data-id=inbox] .count');
  if (c) { c.hidden = !S.inboxCount; c.textContent = S.inboxCount; }
  return S.inboxCount;
}

let lastInboxCount = 0;
/** 一定時間ごとに受信箱を確認し、新しく届いていたら知らせる */
async function inboxTick() {
  if (!S.auth) return;
  const before = S.inboxCount || 0;
  const n = await refreshInboxCount();
  if (n > before && n > lastInboxCount) toast(`📬 受信箱に新しいお知らせが届きました（${n}件）`);
  lastInboxCount = Math.max(lastInboxCount, n);
}

Views.inbox = (() => {
  let root, filter = 'all';
  const render = (c) => { root = c; draw(true); };
  const onStatus = () => {};

  async function draw(check) {
    if (check) { clear(root).appendChild(h('div', { class: 'pad' }, h('h2', {}, '📬 受信箱'), h('div', { class: 'empty' }, '確認中…'))); await refreshInboxCount(); }
    if (!root.isConnected) return;
    const invites = S.invites || []; const notes = S.notes || [];
    const shown = notes.filter((n) => filter === 'all' || n.kind === filter);
    const count = (k) => notes.filter((n) => k === 'all' || n.kind === k).length;
    const tab = (k, label) => h('button', { class: 'btn small' + (filter === k ? ' primary' : ''), onclick: () => { filter = k; draw(false); } }, `${label}（${count(k)}）`);

    clear(root).appendChild(h('div', { class: 'pad' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
        h('div', { style: { flex: 1 } }, h('h2', {}, '📬 受信箱'), h('p', { class: 'sub' }, 'チームからの招待、変更の提案（プルリクエスト）、課題（Issue）などのお知らせが届きます。ふだんは自動で確認しています（3分ごと）。')),
        h('button', { class: 'btn primary', id: 'inboxCheck', onclick: () => draw(true) }, '🔄 いま確認する')),

      h('div', { class: 'card' }, h('h3', {}, `📨 招待（${invites.length}件）`),
        invites.length ? h('div', { class: 'list' }, invites.map((i) => h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, i.repo)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${i.inviter} さんから　${relTime(i.createdAt)}　権限：${roleLabel(i.role)}`)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn small primary', onclick: async () => { await acceptInviteFlow(i); draw(true); } }, '参加する'),
            h('button', { class: 'btn small', onclick: async () => { if (await withBusy('処理中…', () => GH('declineInvite', i.id))) { toast('お断りしました'); draw(true); } } }, 'お断りする')))))
          : h('div', { class: 'empty' }, '届いている招待はありません。')),

      h('div', { class: 'card' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
          h('h3', { style: { margin: 0, flex: 1 } }, `🔔 お知らせ（${notes.length}件）`),
          tab('all', 'すべて'), tab('pr', '変更の提案'), tab('issue', '課題'), tab('other', 'その他'),
          notes.length ? h('button', { class: 'btn small', onclick: markAll }, '✓ すべて既読にする') : null),
        shown.length ? h('div', { class: 'list' }, shown.map(noteRow)) : h('div', { class: 'empty' }, notes.length ? 'この種類のお知らせはありません。' : '新しいお知らせはありません。')),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, '「既読にする」は、GitHub 上でも既読になります。')));
  }

  function noteRow(n) {
    const [label, color] = noteReason(n.reason);
    return h('div', { class: 'row', dataset: { note: n.id } },
      h('span', {}, NOTE_ICON[n.kind] || '🔔'),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, h('b', {}, n.title), n.number ? h('span', { class: 'muted', style: { marginLeft: '6px' } }, '#' + n.number) : null),
        h('div', { class: 'muted', style: { fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { class: 'pill' + (color ? ' ' + color : '') }, label), h('span', {}, n.repo), h('span', {}, relTime(n.updatedAt)))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => { APP('openExternal', n.url).catch(showError); } }, 'ブラウザで開く'),
        h('button', { class: 'btn small', onclick: () => markOne(n) }, '既読にする')));
  }

  async function markOne(n) {
    if (await withBusy('処理中…', () => GH('markNotificationRead', n.id)) === undefined) return;
    S.notes = (S.notes || []).filter((x) => x.id !== n.id); await refreshInboxCount(); draw(false);
  }
  async function markAll() {
    if (await withBusy('処理中…', () => GH('markAllNotificationsRead')) === undefined) return;
    S.notes = []; await refreshInboxCount(); toast('すべて既読にしました'); draw(false);
  }

  return { render, onStatus };
})();
