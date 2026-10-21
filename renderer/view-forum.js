'use strict';
/* やさしいGitへの不具合報告・機能要望を、GitHub Issueでやりとりする画面 */
Views.forum = (() => {
  const repo = 'rumo-dev/yasashii-git';
  let root, state = 'open', token = 0;

  function render(container) { root = container; draw(); }

  async function draw() {
    const my = ++token;
    clear(root).appendChild(h('div', { class: 'pad' },
      h('h2', {}, '💬 バグ報告・要望'),
      h('p', { class: 'sub' }, 'やさしいGitについて、アプリ内から不具合の報告や機能の提案を投稿できます。投稿とコメントはGitHub上で公開されます。'),
      !S.repo ? h('button', { class: 'btn', style: { marginBottom: '12px' }, onclick: () => renderWelcome() }, '← 最初の画面に戻る') : null,
      h('div', { class: 'btn-row', style: { marginBottom: '12px' } },
        h('select', { style: { width: 'auto' }, onchange: (e) => { state = e.target.value; draw(); } },
          [['open', '受付中'], ['closed', '完了'], ['all', 'すべて']].map(([v, label]) => h('option', { value: v, selected: state === v }, label))),
        h('button', { class: 'btn primary', onclick: create }, '＋ 投稿する'),
        h('button', { class: 'btn', onclick: draw }, '🔄 更新'),
        h('button', { class: 'btn', onclick: () => APP('openExternal', `https://github.com/${repo}/issues`) }, 'ブラウザで開く')),
      h('div', { class: 'forum-list' }, h('div', { class: 'empty' }, '読み込み中…'))));
    const listEl = root.querySelector('.forum-list');
    let list;
    try { list = await GH('forumList', state); }
    catch (e) { if (my === token && root.isConnected) clear(listEl).appendChild(h('div', { class: 'card' }, e.message)); return; }
    if (my !== token || !root.isConnected) return;
    clear(listEl);
    if (!list.length) { listEl.appendChild(h('div', { class: 'empty' }, state === 'open' ? '受付中の投稿はありません。' : '該当する投稿はありません。')); return; }
    listEl.appendChild(h('div', { class: 'list' }, list.map((item) => {
      const title = item.title || '';
      const category = title.startsWith('[要望]') ? '💡 要望' : title.startsWith('[バグ]') ? '🐛 バグ' : title.startsWith('[相談]') ? '💬 相談' : '💬 投稿';
      const comments = Array.isArray(item.comments) ? item.comments.length : Number(item.comments) || 0;
      return h('div', { class: 'row' },
        h('span', {}, item.state === 'OPEN' ? '🟢' : '✅'),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, h('span', { class: 'pill blue', style: { marginRight: '6px' } }, category), h('b', {}, `#${item.number} ${title.replace(/^\[(?:要望|バグ)\]\s*/, '')}`)),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, `👤 ${item.author ? item.author.login : ''}　${relTime(item.createdAt)}　💬 ${comments}`)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => comment(item) }, 'コメント'),
          h('button', { class: 'btn small', onclick: () => APP('openExternal', item.url) }, 'ブラウザで開く')));
    })));
  }

  async function create() {
    const form = await formDialog({ title: '投稿する', okLabel: '投稿する', intro: '投稿内容とコメントはGitHub上で公開されます。個人情報やパスワード、アクセストークンを書かないでください。', fields: [
      { key: 'category', label: '投稿の種類', type: 'select', value: 'bug', options: [{ value: 'bug', label: '🐛 不具合の報告' }, { value: 'feature', label: '💡 機能の要望' }, { value: 'other', label: '💬 質問・相談' }] },
      { key: 'title', label: 'タイトル', required: true, placeholder: '内容がわかる短いタイトル' },
      { key: 'body', label: '内容', type: 'textarea', rows: 7, required: true, placeholder: '不具合の場合は、起きたこと・再現手順・OSとアプリのバージョンを書いてください。' },
    ] });
    if (!form) return;
    const res = await withBusy('投稿中…', () => GH('forumCreate', form));
    if (res) { toast('投稿しました ✓'); await draw(); }
  }

  async function comment(item) {
    const form = await formDialog({ title: `#${item.number} にコメント`, okLabel: '送信する', fields: [
      { key: 'body', label: 'コメント', type: 'textarea', rows: 5, required: true },
    ] });
    if (!form) return;
    if (await withBusy('送信中…', () => GH('forumComment', item.number, form.body))) { toast('コメントしました ✓'); await draw(); }
  }

  return { render };
})();
