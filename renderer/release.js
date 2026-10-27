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
  const project = S.repo;
  const saved = (S.settings.releaseDestinations || {})[project] || {};
  await refreshStatus(true);
  const st = S.status;
  if (!st.hasCommits) { toast('まだ記録がありません。先に「変更を記録」してください。', 'error'); return false; }
  const d = await withBusy('リリースの準備中…', () => G('releaseDraft'));
  if (!d) return false;
  const dirty = S.status.files.length;
  const intro = [
    d.lastTag ? `前のバージョンは「${d.lastTag}」です。それ以降の記録（${d.commits.length}件）から、リリースノートの下書きを作りました。` : 'はじめてのリリースです。これまでの記録から、リリースノートの下書きを作りました。',
    '「リリースを作る」を押すと、指定したリリース先にリリースを作ります。リリース先を省略すると、いまの記録に目印をつけてGitHubへ送ります。',
    dirty ? `※ 記録していない変更が ${dirty} 件あります。それらはリリースに含まれません。` : '',
  ].filter(Boolean).join('\n');
  const r = await formDialog({
    title: '🚀 リリースを作る', okLabel: 'リリースを作る', wide: true, intro,
    fields: [
      { key: 'repository', label: 'リリース先リポジトリ（省略するとこのプロジェクト）', value: saved.repository || '', placeholder: '例：your-name/app-releases', help: '所有者/リポジトリ名で指定します。公開先と分岐は、このプロジェクト用に保存され、次回も入力されます。別のリポジトリへソースコードは送信しません。書き込み権限が必要です。' },
      { key: 'target', label: '指定先でタグを作る分岐（省略すると既存タグを使用）', value: saved.target || '', placeholder: '例：main', help: 'リリース先を指定した場合のみ使用します。指定先にバージョン名のタグがない場合、この分岐から作ります。空のリポジトリには先にREADMEなどの記録を作成してください。' },
      { key: 'tag', label: 'バージョン名', value: tag || d.headTags[0] || d.suggested, mono: true, required: true, help: '例：v1.0.0　（空白は使えません）' },
      { key: 'title', label: 'タイトル（省略するとバージョン名）', placeholder: '例：ログイン機能を追加' },
      { key: 'notes', label: 'リリースノート', type: 'textarea', rows: 10, value: d.notes },
      { key: 'draft', label: '下書きとして保存する（まだ公開しない）', type: 'checkbox', value: false },
      { key: 'prerelease', label: '先行版（お試し版）にする', type: 'checkbox', value: false }],
  });
  if (!r) return false;
  const name = r.tag.trim();
  if (/\s/.test(name) || name.startsWith('-')) { toast('バージョン名に、空白や先頭の「-」は使えません。', 'error'); return false; }
  const repository = (r.repository || '').trim();
  const target = (r.target || '').trim();
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) { toast('リリース先は「所有者/リポジトリ名」で入力してください。', 'error'); return false; }
  if (target && (!repository || target.startsWith('-') || /[\s\0]/.test(target))) { toast('作成先の分岐名とリリース先を確認してください。', 'error'); return false; }
  if (repository && !(await confirmDialog({ title: 'リリース先を確認', message: `「${repository}」に「${name}」を${r.draft ? '下書き保存' : '公開'}します。\n${target ? `タグがなければ指定先の「${target}」から作ります。` : '指定先にある同名のタグを使用します。'}\nリリースノートには、このプロジェクトの記録のメモが含まれます。内容を確認してください。`, okLabel: 'このリポジトリに作る' }))) return false;
  await saveSettings({ releaseDestinations: { ...(S.settings.releaseDestinations || {}), [project]: { repository, target } } });

  if (!repository) {
    if (!S.hasRemote) { toast('先に「アップロード」して、GitHubにプロジェクトを作ってください。', 'error'); return false; }

    // まだ送っていない記録があれば、先にアップロード（リリースに含めるため）
    if (st.ahead) {
      const ok = await confirmDialog({ title: '先にアップロードしますか？', message: `まだGitHubに送っていない記録が ${st.ahead} 件あります。\nリリースにはGitHub上の内容が使われるため、先にアップロードします。`, okLabel: 'アップロードして続ける' });
      if (!ok) return false;
      if (!(await doPush())) return false;
      await refreshStatus(true);
      if (S.status.ahead) return false;
    }

  }

  const res = await withBusyThrow('リリースを作成中…', async () => {
    if (!repository) {
      const have = (await G('tags')).some((t) => t.name === name);
      if (!have) await G('createTag', name, { message: r.title.trim() || name });
      await G('pushTag', name, await releaseRemoteName());
    }
    return GH('createRelease', S.repo, { tag: name, title: r.title, notes: r.notes, draft: r.draft, prerelease: r.prerelease, repository, target });
  }).catch(async (e) => { await showError(e); return undefined; });
  if (!res) { await refreshAll(); return false; }
  await refreshAll();
  const open = await modal({ title: r.draft ? '📝 下書きのリリースを保存しました' : '🎉 リリースを作りました',
    body: h('div', {}, h('p', { style: { marginTop: 0 } }, `「${name}」をGitHubに${r.draft ? '下書きとして保存' : '公開'}しました。`),
      res.url ? h('div', { class: 'mono muted', style: { fontSize: '12px', wordBreak: 'break-all' } }, res.url) : null,
      r.draft ? h('p', { class: 'muted' }, '公開するには、GitHubの画面で「Publish release」を押してください。') : h('p', { class: 'muted' }, repository ? '指定先にリリースを作成しました。配布ファイルはGitHubのリリース画面から追加できます。' : 'このプロジェクトで、目印（タグ）をきっかけにインストーラーを自動で作る設定にしている場合は、ここから自動ビルドが始まります。')),
    buttons: [{ label: '閉じる', value: false }, ...(res.url ? [{ label: '🌐 ブラウザで開く', kind: 'primary', value: true }] : [])] });
  if (open === true && res.url) APP('openExternal', res.url).catch(() => {});
  return true;
}
