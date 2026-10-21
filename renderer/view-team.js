'use strict';
/* 「チーム」画面：共有リンク・メンバー・招待（送る／届いた招待に返事する）・リンクで参加 */

const ROLES = { write: ['roleWrite', '✏️'], read: ['roleRead', '👀'], admin: ['roleAdmin', '🛡️'] };
const roleLabel = (r) => (ROLES[r] ? jp(ROLES[r][0]) : r);
const rolePill = (r) => h('span', { class: 'pill' + (r === 'admin' ? ' yellow' : r === 'write' ? ' green' : '') , title: hint(ROLES[r] ? ROLES[r][0] : '') }, (ROLES[r] ? ROLES[r][1] + ' ' : '') + roleLabel(r), settingsRef.showOriginal ? h('span', { class: 'en' }, r) : null);

/** 届いている招待の数を調べて、画面の印に反映する */
async function refreshInviteCount() {
  try { S.invites = await GH('myInvites'); } catch (_) { S.invites = []; }
  S.inviteCount = S.invites.length;
  updateInviteBanner();
  const c = document.querySelector('.nav-item[data-id=team] .count');
  if (c) { c.hidden = !S.inviteCount; c.textContent = S.inviteCount; }
  return S.inviteCount;
}

/** 画面の上に「招待が届いています」の帯を出す（どの画面にいても、そこから参加できる） */
function updateInviteBanner() {
  const b = document.getElementById('inviteBanner'); if (!b) return;
  clear(b);
  b.hidden = !S.inviteCount;
  if (!S.inviteCount) return;
  b.append(h('span', { class: 'grow' }, `📨 チームから招待が ${S.inviteCount} 件届いています`),
    h('button', { class: 'btn small primary', onclick: invitesDialog }, '確認して参加する'));
}
let lastInviteCount = 0;
/** 一定時間ごとに招待を確認し、新しく届いたら知らせる */
async function inviteTick() {
  if (!S.auth) return;
  const before = S.inviteCount;
  const n = await refreshInviteCount();
  if (n > before && n > lastInviteCount) toast(`📨 新しい招待が届きました（${n}件）`);
  lastInviteCount = Math.max(lastInviteCount, n);
}

/** 届いた招待の一覧（参加する／お断りする）。参加したらダウンロードへ進める */
async function invitesDialog() {
  const list = await withBusy('招待を確認中…', () => GH('myInvites'));
  if (list === undefined) return;
  S.invites = list; S.inviteCount = list.length;
  if (!list.length) { await modal({ title: '📨 届いている招待', body: h('div', { class: 'empty' }, '招待は届いていません。'), buttons: [{ label: '閉じる', kind: 'primary', value: true }] }); return; }
  const rows = list.map((i) => h('div', { class: 'row' },
    h('span', {}, '📨'),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, i.repo)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${i.inviter} さんからの招待　${relTime(i.createdAt)}　権限：${roleLabel(i.role)}`)),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: () => { document.querySelector('.overlay')?.remove(); acceptInviteFlow(i); } }, '参加する'),
      h('button', { class: 'btn small', onclick: async () => { if (await withBusy('処理中…', () => GH('declineInvite', i.id))) { toast('お断りしました'); document.querySelector('.overlay')?.remove(); invitesDialog(); } } }, 'お断りする'))));
  await modal({ title: '📨 届いている招待', wide: true, body: h('div', {}, h('p', { class: 'muted', style: { marginTop: 0 } }, '「参加する」を押すと、そのプロジェクトのメンバーになります。'), h('div', { class: 'list' }, rows)), buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
  refreshInviteCount();
}

async function acceptInviteFlow(i) {
  const ok = await withBusy('参加しています…', () => GH('acceptInvite', i.id));
  if (!ok) return;
  toast(`「${i.repo}」に参加しました 🎉`);
  refreshInviteCount();
  if (await confirmDialog({ title: '手元にダウンロードしますか？', message: `「${i.repo}」を、このパソコンにダウンロードして作業を始めます。`, okLabel: 'ダウンロードする' })) cloneFlow(i.repo);
}

/** チームから送られたリンク（または招待）で参加する。ダウンロードするプロジェクトの「ユーザー名/名前」を返す（やめたら null） */
async function resolveLink() {
  const f = await formDialog({
    title: '🔗 リンクで参加する', okLabel: '次へ',
    intro: 'チームの人から送られた、GitHubのリンク（URL）を貼り付けてください。招待メールの「View invitation」のリンクでも大丈夫です。',
    fields: [{ key: 'url', label: 'リンク', placeholder: 'https://github.com/チーム名/プロジェクト名', required: true, help: '「ユーザー名/プロジェクト名」だけでもOKです。' }] });
  if (!f) return null;
  const ref = parseRepoRef(f.url);
  if (!ref) {
    // GitHub以外のサーバーなど：そのままURLとして扱う
    return /^(https?:\/\/|git@|ssh:\/\/)/i.test(f.url.trim()) ? f.url.trim() : (toast('リンクの形式が正しくありません。', 'error'), null);
  }
  const name = `${ref.owner}/${ref.repo}`;
  const acc = await withBusy('リンク先を確認中…', () => GH('checkAccess', name));
  if (acc === undefined) return null;
  if (acc.ok) return acc.ref;
  if (acc.invite) {
    const ok = await confirmDialog({ title: '📨 招待が届いています', message: `「${acc.ref}」への招待が、${acc.invite.inviter} さんから届いています。\n参加して、ダウンロードしますか？`, okLabel: '参加してダウンロード' });
    if (!ok) return null;
    if (!(await withBusy('参加しています…', () => GH('acceptInvite', acc.invite.id)))) return null;
    toast('参加しました 🎉'); refreshInviteCount();
    return acc.ref;
  }
  // 入れない：招待してもらうよう案内（自分のユーザー名を渡せるように）
  const me = (S.auth && S.auth.login) || await GH('myLogin').catch(() => '');
  await modal({
    title: 'まだ参加できていません',
    body: h('div', {},
      h('p', { style: { marginTop: 0 } }, `「${name}」は、見つからないか、まだ参加が認められていません。`),
      h('p', { class: 'muted' }, 'チームの管理者に、次のあなたのGitHubユーザー名を伝えて、「招待」してもらってください。招待が届いたら、「チーム」画面や、はじめの画面の「招待を確認」から参加できます。'),
      me ? h('div', { class: 'card', style: { textAlign: 'center' } }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'あなたのユーザー名'), h('div', { class: 'mono', style: { fontSize: '22px', fontWeight: 700, margin: '4px 0 8px' } }, me),
        h('button', { class: 'btn small', onclick: () => { APP('copyText', me).catch(() => {}); toast('コピーしました'); } }, '📋 コピーして管理者に送る')) : null,
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'リンクの間違いがないかも確認してください。')),
    buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
  return null;
}
async function joinByLink() { const ref = await resolveLink(); if (ref) cloneFlow(ref); }

Views.team = (() => {
  let root, body;
  const render = (c) => { root = c; draw(); };
  const onStatus = () => {};

  async function draw() {
    body = h('div', {});
    clear(root).appendChild(h('div', { class: 'pad' },
      h('h2', {}, '👥 チーム'),
      h('p', { class: 'sub' }, 'いっしょに作る人を招待したり、届いた招待に参加したり、リンクを共有したりできます。'),
      body));
    body.appendChild(h('div', { class: 'empty' }, '確認中…'));
    let info = null;
    try { info = await GH('currentRepo', S.repo); } catch (_) { info = null; }
    if (!root.isConnected) return;
    const mine = await GH('myInvites').catch(() => []);
    S.invites = mine; refreshInviteCount();
    clear(body);
    body.appendChild(joinCard());
    if (mine.length) body.appendChild(receivedCard(mine));
    if (!info) {
      body.appendChild(h('div', { class: 'card' }, h('h3', {}, '🔗 ', termLabel('shareLink')),
        h('p', { class: 'muted' }, S.hasRemote ? 'このプロジェクトの接続先はGitHubではないようです。チームの機能はGitHubのプロジェクトで使えます。' : 'このプロジェクトは、まだGitHubにありません。「アップロード」を押すとGitHubに作成され、チームを招待できるようになります。'),
        S.hasRemote ? null : h('button', { class: 'btn primary', onclick: async () => { if (await publishToGitHub({ thenPush: true })) draw(); } }, '☁️ GitHubに作成してアップロード')));
      return;
    }
    body.appendChild(shareCard(info));
    const members = h('div', {}, h('div', { class: 'empty' }, '読み込み中…'));
    const sent = h('div', {});
    body.appendChild(members); body.appendChild(sent);
    await Promise.all([loadMembers(info, members), loadSent(info, sent)]);
  }

  function joinCard() {
    return h('div', { class: 'card' }, h('h3', {}, '🔗 リンクで参加する'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'チームの人から送られたリンクを貼り付けて、そのプロジェクトをダウンロードします。まだ招待されていなくても、届いた招待があればここから参加できます。'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: joinByLink }, '🔗 リンクで参加する'), h('button', { class: 'btn', onclick: () => cloneFlow() }, '⬇️ 一覧から選んでダウンロード')));
  }

  function receivedCard(list) {
    return h('div', { class: 'card', style: { borderColor: 'var(--accent)' } }, h('h3', {}, `📨 招待が届いています（${list.length}件）`),
      h('div', { class: 'list' }, list.map((i) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, h('b', {}, i.repo)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${i.inviter} さんから　${relTime(i.createdAt)}　権限：${roleLabel(i.role)}`)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', onclick: async () => { await acceptInviteFlow(i); draw(); } }, '参加する'),
          h('button', { class: 'btn small', onclick: async () => { if (await withBusy('処理中…', () => GH('declineInvite', i.id))) { toast('お断りしました'); draw(); } } }, 'お断りする'))))));
  }

  function shareCard(info) {
    const me = S.auth && S.auth.login;
    return h('div', { class: 'card' }, h('h3', {}, '🔗 ', termLabel('shareLink')),
      h('p', { class: 'muted', style: { marginTop: 0 } }, `「${info.nameWithOwner}」のリンクです。チームの人に送ると、はじめの画面の「リンクで参加」から始められます。（先に下の「招待」をしておく必要があります）`),
      h('div', { class: 'row' }, h('div', { class: 'grow mono title', style: { fontSize: '13px' } }, info.url),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', onclick: () => { APP('copyText', info.url).catch(() => {}); toast('リンクをコピーしました'); } }, '📋 コピー'),
          h('button', { class: 'btn small', onclick: () => APP('openExternal', info.url) }, 'ブラウザで開く'))),
      me ? h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: 0 } }, `あなたのユーザー名：${me}`) : null);
  }

  async function loadMembers(info, el) {
    let list;
    try { list = await GH('listMembers', info.nameWithOwner); } catch (e) { clear(el).appendChild(h('div', { class: 'card' }, h('h3', {}, '👥 ', termLabel('member')), h('p', { class: 'muted' }, e.message))); return; }
    const me = (S.auth && S.auth.login || '').toLowerCase();
    clear(el).appendChild(h('div', { class: 'card' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } }, h('h3', { style: { margin: 0, flex: 1 } }, `👥 ${jp('member')}（${list.length}人）`, settingsRef.showOriginal ? h('span', { class: 'en' }, 'collaborators') : null),
        h('button', { class: 'btn primary', onclick: () => invite(info) }, '＋ 招待する')),
      h('div', { class: 'list' }, list.map((m) => h('div', { class: 'row' },
        h('span', {}, '👤'), h('div', { class: 'grow' }, h('b', {}, m.login), m.login.toLowerCase() === me ? h('span', { class: 'pill blue', style: { marginLeft: '6px' } }, 'あなた') : null),
        rolePill(m.role),
        m.login.toLowerCase() === me ? null : h('button', { class: 'btn small danger', onclick: () => removeMember(info, m) }, 'メンバーから外す'))))));
  }

  async function loadSent(info, el) {
    let list; try { list = await GH('listSentInvites', info.nameWithOwner); } catch (_) { return; }
    if (!list.length) return;
    clear(el).appendChild(h('div', { class: 'card' }, h('h3', {}, `⏳ 返事待ちの${jp('invite')}（${list.length}件）`),
      h('p', { class: 'muted', style: { marginTop: 0 } }, '相手が「参加する」を押すとメンバーになります。メールが届かない場合は、下の「招待リンクをコピー」で相手に直接送れます。'),
      h('div', { class: 'list' }, list.map((i) => h('div', { class: 'row' },
        h('span', {}, '✉️'), h('div', { class: 'grow' }, h('b', {}, i.login), h('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '8px' } }, relTime(i.createdAt))),
        rolePill(i.role),
        h('button', { class: 'btn small', onclick: () => { APP('copyText', `https://github.com/${info.nameWithOwner}/invitations`).catch(() => {}); toast('招待リンクをコピーしました'); } }, '📋 招待リンクをコピー'),
        h('button', { class: 'btn small danger', onclick: async () => { if (await withBusy('取り消し中…', () => GH('cancelSentInvite', info.nameWithOwner, i.id))) { toast('招待を取り消しました'); draw(); } } }, '取り消す'))))));
  }

  async function invite(info) {
    const r = await formDialog({
      title: '＋ メンバーを招待する', okLabel: '招待を送る',
      intro: `「${info.nameWithOwner}」に、いっしょに作業する人を招待します。相手のGitHubユーザー名を入力してください。\n（ユーザー名は、相手のGitHubのページのアドレス github.com/○○○ の「○○○」の部分です）`,
      fields: [
        { key: 'user', label: '相手のGitHubユーザー名', placeholder: '例：taro-yamada', required: true, mono: true },
        { key: 'role', label: 'できること', type: 'select', value: 'write', options: [
          { value: 'write', label: `✏️ ${jp('roleWrite')}（いっしょに作る人におすすめ）` },
          { value: 'read', label: `👀 ${jp('roleRead')}（変更はできません）` },
          { value: 'admin', label: `🛡️ ${jp('roleAdmin')}（メンバーの管理もできます）` }] }] });
    if (!r) return;
    const res = await withBusy('招待を送っています…', () => GH('inviteMember', info.nameWithOwner, r.user, r.role));
    if (!res) return;
    if (res.invited) {
      const copy = await confirmDialog({ title: '招待を送りました ✉️', message: `${res.login} さんに招待を送りました。相手が「参加する」を押すとメンバーになります。\n\nメールが届かないときは、招待リンクを直接送ることもできます。`, okLabel: '招待リンクをコピー' });
      if (copy) { APP('copyText', res.url).catch(() => {}); toast('招待リンクをコピーしました'); }
    } else toast(`${res.login} さんは、すでにメンバーです（権限を更新しました）`);
    draw();
  }

  async function removeMember(info, m) {
    if (!(await confirmDialog({ title: `${m.login} さんをメンバーから外しますか？`, message: 'このプロジェクトに変更をアップロードできなくなります。（その人の過去の記録は消えません）', okLabel: '外す', danger: true }))) return;
    if (await withBusy('処理中…', () => GH('removeMember', info.nameWithOwner, m.login))) { toast('メンバーから外しました'); draw(); }
  }

  return { render, onStatus };
})();
