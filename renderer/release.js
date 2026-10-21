'use strict';
/**
 * リリースの生成。
 * 「目印（バージョン名）をつける → サーバーへ送る → GitHub にリリースを作る」を、1つの流れで行う。
 *   ・バージョン名は、前の v1.2.3 から次の候補（v1.2.4）を自動で提案する
 *   ・リリースノートは、前のバージョンからの「記録のメモ」から下書きを作る（自由に書き換えられる）
 *   ・まだアップロードしていない記録があれば、先にアップロードする（リリースに含めるため）
 *   ・タグを GitHub Actions のトリガーにしているプロジェクトでは、ここで配布ファイルの自動ビルドも始まる
 */
async function releaseRemoteName() {
  const rs = await G('remotes');
  return (rs.find((r) => r.name === 'origin') || rs[0]).name;
}

async function releaseFlow({ tag = '' } = {}) {
  if (!S.repo) return false;
  await refreshStatus(true);
  const st = S.status;
  if (!st.hasCommits) { toast('まだ記録がありません。先に「変更を記録」してください。', 'error'); return false; }
  if (!S.hasRemote) { toast('先に「アップロード」して、GitHubにプロジェクトを作ってください。', 'error'); return false; }

  // まだ送っていない記録があれば、先にアップロード（リリースに含めるため）
  if (st.ahead) {
    const ok = await confirmDialog({ title: '先にアップロードしますか？', message: `まだGitHubに送っていない記録が ${st.ahead} 件あります。\nリリースにはGitHub上の内容が使われるため、先にアップロードします。`, okLabel: 'アップロードして続ける' });
    if (!ok) return false;
    if (!(await doPush())) return false;
    await refreshStatus(true);
    if (S.status.ahead) return false;
  }

  const d = await withBusy('リリースの準備中…', () => G('releaseDraft'));
  if (!d) return false;
  const dirty = S.status.files.length;
  const intro = [
    d.lastTag ? `前のバージョンは「${d.lastTag}」です。それ以降の記録（${d.commits.length}件）から、リリースノートの下書きを作りました。` : 'はじめてのリリースです。これまでの記録から、リリースノートの下書きを作りました。',
    '「リリースを作る」を押すと、いまの最新の記録にバージョン名（目印）をつけてGitHubへ送り、リリースを公開します。',
    dirty ? `※ 記録していない変更が ${dirty} 件あります。それらはリリースに含まれません。` : '',
  ].filter(Boolean).join('\n');
  const r = await formDialog({
    title: '🚀 リリースを作る', okLabel: 'リリースを作る', wide: true, intro,
    fields: [
      { key: 'tag', label: 'バージョン名', value: tag || d.headTags[0] || d.suggested, mono: true, required: true, help: '例：v1.0.0　（空白は使えません）' },
      { key: 'title', label: 'タイトル（省略するとバージョン名）', placeholder: '例：ログイン機能を追加' },
      { key: 'notes', label: 'リリースノート', type: 'textarea', rows: 10, value: d.notes },
      { key: 'draft', label: '下書きとして保存する（まだ公開しない）', type: 'checkbox', value: false },
      { key: 'prerelease', label: '先行版（お試し版）にする', type: 'checkbox', value: false }],
  });
  if (!r) return false;
  const name = r.tag.trim();
  if (/\s/.test(name) || name.startsWith('-')) { toast('バージョン名に、空白や先頭の「-」は使えません。', 'error'); return false; }

  const res = await withBusyThrow('リリースを作成中…', async () => {
    const have = (await G('tags')).some((t) => t.name === name);
    if (!have) await G('createTag', name, { message: r.title.trim() || name });
    await G('pushTag', name, await releaseRemoteName());
    return GH('createRelease', S.repo, { tag: name, title: r.title, notes: r.notes, draft: r.draft, prerelease: r.prerelease });
  }).catch(async (e) => { await showError(e); return undefined; });
  if (!res) { await refreshAll(); return false; }
  await refreshAll();
  const open = await modal({ title: r.draft ? '📝 下書きのリリースを保存しました' : '🎉 リリースを作りました',
    body: h('div', {}, h('p', { style: { marginTop: 0 } }, `「${name}」をGitHubに${r.draft ? '下書きとして保存' : '公開'}しました。`),
      res.url ? h('div', { class: 'mono muted', style: { fontSize: '12px', wordBreak: 'break-all' } }, res.url) : null,
      r.draft ? h('p', { class: 'muted' }, '公開するには、GitHubの画面で「Publish release」を押してください。') : h('p', { class: 'muted' }, 'このプロジェクトで、目印（タグ）をきっかけにインストーラーを自動で作る設定にしている場合は、ここから自動ビルドが始まります。')),
    buttons: [{ label: '閉じる', value: false }, ...(res.url ? [{ label: '🌐 ブラウザで開く', kind: 'primary', value: true }] : [])] });
  if (open === true && res.url) APP('openExternal', res.url).catch(() => {});
  return true;
}
