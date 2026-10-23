'use strict';
/* 「作業の分岐」画面 */
Views.branches = (() => {
  let root, data = null, flowConfig = null, token = 0;
  const open = { local: true, remote: false };   // 折りたたみの状態（手元は開く／サーバーは閉じる）

  function render(container) { root = container; draw(true); }
  function onStatus() { if (root && root.isConnected) draw(false); }

  async function draw(showLoading) {
    const my = ++token;
    let d, flow;
    try { [d, flow] = await Promise.all([G('branches'), G('gitFlowConfig')]); } catch (e) { if (my === token) { clear(root).appendChild(h('div', { class: 'pad' }, e.message)); } return; }
    if (my !== token) return;
    data = d; flowConfig = flow;
    const st = S.status;
    clear(root);
    root.appendChild(h('div', { class: 'pad' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
        h('div', { style: { flex: 1 } }, h('h2', {}, '🌿 ', termLabel('branch')), h('p', { class: 'sub' }, hint('branch') + ' 新しい機能や修正は、専用の分岐で進めると安心です。')),
        h('button', { class: 'btn primary', onclick: createBranch }, '＋ 新しい作業の分岐を作る')),
      st.detached ? h('div', { class: 'card', style: { background: 'var(--warn-bg)', color: 'var(--warn)' } }, `⚠ いまは${jp('detached')}です。${hint('detached')}`) : null,
      gitFlowCard(d, st, flow),
      section('local', '🌿 手元の分岐', d.local.length,
        d.local.length ? d.local.map(localRow) : h('div', { class: 'empty' }, 'まだ分岐がありません。最初の記録を作ると「main」などの分岐ができます。')),
      section('remote', '☁️ サーバー（GitHubなど）上の分岐', d.remote.length,
        d.remote.length ? d.remote.map(remoteRow) : h('div', { class: 'empty' }, 'サーバー上の分岐はありません。「更新を確認」を押すと最新の情報を取得できます。'))));
  }

  function gitFlowCard(d, st, flow) {
    if (flow) {
      const currentKind = flowKind(flow, st.branch);
      const flowRows = d.local.filter((b) => flowKind(flow, b.name));
      return h('div', { class: 'card' },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } },
          h('div', { class: 'grow' }, h('b', {}, 'GitFlowで作業を進める'),
            h('p', { class: 'muted', style: { margin: '5px 0 10px', fontSize: '13px' } }, `本番用「${flow.productionBranch}」／開発用「${flow.developmentBranch}」。featureは開発用から、releaseは開発用から、hotfixは本番用から始まります。`)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn small', onclick: () => beginGitFlow('feature') }, '＋ 機能を作る'),
            h('button', { class: 'btn small', onclick: () => beginGitFlow('release') }, '＋ リリース準備'),
            h('button', { class: 'btn small', onclick: () => beginGitFlow('hotfix') }, '＋ 緊急修正'))),
        currentKind ? h('p', { class: 'muted', style: { margin: '4px 0 0', fontSize: '12px' } }, `現在「${st.branch}」で作業中です。分岐一覧の「GitFlowを完了」から合流できます。`) : null,
        flowRows.length ? null : h('p', { class: 'muted', style: { margin: '6px 0 0', fontSize: '12px' } }, 'GitFlowの作業用分岐はまだありません。上のボタンから始められます。'));
    }
    const preferred = ['main', 'master'].find((name) => d.local.some((b) => b.name === name));
    const hasProduction = d.local.length > 0;
    return h('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' } },
      h('div', { class: 'grow' },
        h('b', {}, 'GitFlowで作業を始める'),
        h('p', { class: 'muted', style: { margin: '5px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' } },
          '本番用の分岐（main / master）と、開発用の分岐（develop）を準備します。機能追加は feature/名前、公開準備は release/名前、緊急修正は hotfix/名前、という名前の付け方も保存します。')),
      h('button', { class: 'btn', disabled: !hasProduction || !st.hasCommits || st.detached || !!st.operation, title: !st.hasCommits ? '最初の変更を記録してから使えます' : '', onclick: () => initializeGitFlow(d, st, preferred) }, 'GitFlowを初期化'));
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
    const flowType = flowKind(flowConfig, b.name);
    if (flowType) acts.append(h('button', { class: 'btn small primary', onclick: () => finishGitFlow(b.name) }, 'GitFlowを完了'));
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
  async function initializeGitFlow(d, st, defaultProduction) {
    const options = d.local.map((b) => ({ value: b.name, label: b.name + (b.name === 'main' || b.name === 'master' ? '（本番用・おすすめ）' : '') }));
    const r = await formDialog({ title: 'GitFlowを初期化', okLabel: '初期化する',
      intro: 'GitFlowは、開発中の変更をdevelopに集め、公開する段階で本番用の分岐へ取り込む進め方です。既存の分岐は名前変更・削除せず、選んだ分岐からdevelopを用意します。',
      fields: [
        { key: 'production', label: '本番用の分岐', type: 'select', value: defaultProduction || st.branch, options },
        { key: 'development', label: '開発用の分岐', value: 'develop', required: true, help: '標準の名前は develop です。すでに同じ名前の分岐がある場合はそれを使います。' },
      ] });
    if (!r) return;
    const savedStash = await stashBeforeGitFlow('初期化');
    if (!savedStash.ok) return;
    const result = await withBusy('GitFlowを初期化中…', () => G('initializeGitFlow', { productionBranch: r.production, developmentBranch: r.development.trim() }));
    if (result) {
      const branchMessage = result.trackedRemote ? `サーバー上の「${result.developmentBranch}」を手元に用意して切り替えました。` : result.created ? `「${result.developmentBranch}」を作成して切り替えました。` : `既存の「${result.developmentBranch}」に切り替えました。`;
      toast(`GitFlowを初期化しました。${branchMessage}${savedStash.name ? ` 作業内容は一時退避「${savedStash.name}」に保存しています。` : ''}`);
      await refreshAll();
    } else if (savedStash.name) {
      toast(`作業内容は一時退避「${savedStash.name}」に保存されたままです。`, 'error');
    }
  }
  function flowKind(config, name) {
    if (!config || !name) return null;
    return ['feature', 'release', 'hotfix'].find((type) => name.startsWith(config.prefixes[type]) && name.length > config.prefixes[type].length) || null;
  }
  async function stashBeforeGitFlow(action) {
    let st;
    try { st = await G('status'); } catch (e) { await showError(e); return { ok: false }; }
    if (st.operation) { toast('進行中の合流などを完了または中止してから、GitFlowの操作をしてください。', 'error'); return { ok: false }; }
    if (!st.files.length) return { ok: true, name: '' };
    const name = await promptDialog({ title: `作業中の変更を一時退避して${action}`, label: '一時退避の名前', placeholder: '例：GitFlow操作前の作業', help: '変更と新しいファイルを一時退避に保存します。GitFlow操作後も一時退避に残ります。必要なら「一時退避」画面から戻してください。', okLabel: '退避して続ける' });
    if (!name) return { ok: false };
    const saved = await withBusy('作業中の変更を一時退避中…', () => G('stashSave', { message: name, includeUntracked: true }));
    return saved === undefined ? { ok: false } : { ok: true, name };
  }
  async function beginGitFlow(type) {
    const labels = { feature: '機能', release: 'リリース準備', hotfix: '緊急修正' };
    const prefix = flowConfig.prefixes[type];
    const r = await formDialog({ title: `${labels[type]}の分岐を作る`, okLabel: '作成して切り替える',
      intro: type === 'hotfix' ? `本番用の「${flowConfig.productionBranch}」から緊急修正用の分岐を作ります。` : `開発用の「${flowConfig.developmentBranch}」から分岐を作ります。`,
      fields: [{ key: 'name', label: `${labels[type]}の名前`, placeholder: '例：login-screen', required: true, help: `「${prefix}」は自動で付けます。名前の部分だけ入力してください。` }] });
    if (!r) return;
    const savedStash = await stashBeforeGitFlow(`${labels[type]}の分岐を作成`);
    if (!savedStash.ok) return;
    const result = await withBusy('GitFlowの分岐を作成中…', () => G('beginGitFlowBranch', { type, name: r.name }));
    if (result) {
      toast(`「${result.branch}」を作成して切り替えました。${savedStash.name ? ` 作業内容は一時退避「${savedStash.name}」に保存しています。` : ''}`);
      await refreshAll();
    } else if (savedStash.name) toast(`作業内容は一時退避「${savedStash.name}」に保存されたままです。`, 'error');
  }
  async function finishGitFlow(branch) {
    const type = flowKind(flowConfig, branch);
    const labels = { feature: '機能', release: 'リリース', hotfix: '緊急修正' };
    let tagName = '';
    if (type === 'release' || type === 'hotfix') {
      const suggested = branch.slice(flowConfig.prefixes[type].length);
      const r = await formDialog({ title: `${labels[type]}を完了`, okLabel: '合流して完了',
        intro: `「${branch}」を本番用「${flowConfig.productionBranch}」と開発用「${flowConfig.developmentBranch}」に取り込み、バージョンの目印を付けてから分岐を削除します。`,
        fields: [{ key: 'tag', label: 'バージョン（目印）', value: suggested, placeholder: '例：1.2.0', required: true,
          help: flowConfig.prefixes.versiontag ? `目印には「${flowConfig.prefixes.versiontag}」が自動で付きます。` : '目印の名前に使うバージョンを入力してください。' }] });
      if (!r) return;
      tagName = r.tag;
    } else {
      const ok = await confirmDialog({ title: '機能の作業を完了しますか？', message: `「${branch}」を開発用「${flowConfig.developmentBranch}」に合流して、作業用の分岐を削除します。`, okLabel: '合流して完了' });
      if (!ok) return;
    }
    const savedStash = await stashBeforeGitFlow(`${labels[type]}の作業を完了`);
    if (!savedStash.ok) return;
    const result = await withBusy('最新の状態を確認して、GitFlowの作業を合流中…', () => G('finishGitFlowBranch', { branch, tagName }));
    if (result && result.conflict) {
      await afterConflictCheck(result, null);
      return;
    }
    if (result) {
      toast(`${labels[type]}「${branch}」を完了しました。${result.tag ? ` 目印「${result.tag}」を作成しました。` : ''}${savedStash.name ? ` 作業内容は一時退避「${savedStash.name}」に保存しています。` : ''}`);
      await refreshAll();
    } else if (savedStash.name) toast(`作業内容は一時退避「${savedStash.name}」に保存されたままです。`, 'error');
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

  /** 左のブランチ一覧を右クリックしたときの操作メニュー */
  async function openSideMenu(e, branch, remote = false) {
    e.preventDefault(); e.stopPropagation();
    try {
      const [branchesNow, flow] = await Promise.all([G('branches'), G('gitFlowConfig')]);
      data = branchesNow; flowConfig = flow;
    } catch (err) { await showError(err); return; }
    if (remote) {
      const remoteName = branch.name.split('/')[0];
      const shortName = branch.name.slice(remoteName.length + 1);
      const haveLocal = data.local.some((b) => b.name === shortName);
      contextMenu(e, [
        haveLocal ? { label: '✓ 手元にもあります', disabled: true } : { label: '⬇ 手元に持ってきて切り替え', onclick: () => checkoutRemote(branch.name) },
        'sep',
        { label: '今の分岐に合流', onclick: () => mergeInto(branch.name) },
        'sep',
        { label: '🗑 サーバーから削除', danger: true, onclick: () => delRemote(remoteName, shortName) },
      ]);
      return;
    }
    const flowType = flowKind(flowConfig, branch.name);
    const items = [];
    if (!branch.current) items.push({ label: '切り替え', onclick: () => switchTo(branch.name) });
    if (!branch.current) items.push({ label: '今の分岐に合流', onclick: () => mergeInto(branch.name) });
    items.push('sep', { label: '名前変更', onclick: () => rename(branch.name) });
    if (flowType) items.push({ label: 'GitFlowを完了', onclick: () => finishGitFlow(branch.name) });
    if (branch.current && branch.upstream) items.push({ label: jp('force'), danger: true, onclick: forcePush });
    if (!branch.current) items.push('sep', { label: '🗑 削除', danger: true, onclick: () => del(branch.name) });
    contextMenu(e, items);
  }

  return { render, onStatus, openSideMenu };
})();
