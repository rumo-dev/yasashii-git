'use strict';
/**
 * アプリの更新のお知らせ。
 * メイン側（src/updater.js）が新しい版を見つけると、画面の上に帯を出して知らせる。
 *   見つかった → 「更新する」（自動で入れ替えられる環境）／「ダウンロードページを開く」（それ以外）
 *   ダウンロード中 → 進み具合
 *   準備できた → 「再起動して更新」
 * 帯は「あとで」で閉じられる。閉じたあとも、左のメニューの下と「設定」画面から、いつでも更新できる。
 */
const Upd = (() => {
  let st = null;                 // 最新の状態（src/updater.js の state）
  let dismissedKey = '';         // 「あとで」で閉じた状態（版 + 段階）。段階が進めば（準備できた等）また出す
  const binders = [];            // 設定画面など、状態が変わったら描き直したい場所

  const active = (s) => !!s && ['available', 'downloading', 'downloaded'].includes(s.status);
  const keyOf = (s) => (s ? `${s.version}:${s.status}` : '');
  const state = () => st;

  function apply(next) {
    if (!next) return;
    st = next; S.update = next;
    render();
    for (let i = binders.length - 1; i >= 0; i--) { if (binders[i].el.isConnected) binders[i].fn(); else binders.splice(i, 1); }
  }

  /** el が画面にある間、状態が変わるたびに fn を呼ぶ */
  function bind(el, fn) { binders.push({ el, fn }); }

  /* ---- 上の帯・左下のリンク ---- */
  function render() {
    const bar = document.getElementById('updateBanner');
    const link = document.getElementById('updateLink');
    if (!bar) return;
    const s = st;
    const hidden = !active(s) || (dismissedKey === keyOf(s) && s.status !== 'downloading');
    if (link) { link.hidden = !(active(s) && hidden); if (!link.hidden) link.textContent = s.status === 'downloaded' ? '🆕 更新の準備ができました' : '🆕 新しい版があります'; }
    bar.hidden = hidden;
    if (hidden) return;
    clear(bar);
    const ver = `v${s.version || ''}`;
    if (s.status === 'available') {
      const auto = s.mode === 'auto';
      bar.append(...[
        h('span', { class: 'grow' }, `🆕 新しい版 ${ver} が出ています。（いまは v${s.currentVersion}）`),
        s.notes ? h('button', { class: 'btn small', onclick: showNotes }, '更新内容を見る') : null,
        h('button', { class: 'btn small primary', onclick: startUpdate }, auto ? '⬇ 更新する' : '🌐 ダウンロードページを開く'),
        h('button', { class: 'btn small ghost', title: 'あとで', onclick: dismiss }, 'あとで')].filter(Boolean));
    } else if (s.status === 'downloading') {
      const pct = Math.max(2, Math.min(100, s.percent || 0));
      bar.append(
        h('span', {}, `⬇ ${ver} をダウンロード中… ${Math.round(s.percent || 0)}%`),
        h('div', { class: 'bar' }, h('div', { style: { width: pct + '%' } })));
    } else if (s.status === 'downloaded') {
      bar.append(
        h('span', { class: 'grow' }, `✅ ${ver} の準備ができました。再起動すると、新しい版になります。`),
        h('button', { class: 'btn small primary', onclick: restartNow }, '🔄 再起動して更新'),
        h('button', { class: 'btn small ghost', title: 'あとで', onclick: dismiss }, 'あとで'));
    }
    if (s.error && s.status === 'available') bar.appendChild(h('span', { class: 'upd-err' }, s.error));
  }

  function dismiss() { dismissedKey = keyOf(st); render(); }
  function reopen() { dismissedKey = ''; render(); }

  /* ---- 操作 ---- */
  async function startUpdate() {
    let r;
    try { r = await APP('downloadUpdate'); } catch (e) { return showError(e); }
    apply(r);
    if (r && r.error) toast(r.error, 'error');
    else if (r && r.mode !== 'auto') toast('ダウンロードページをブラウザで開きました。新しい版を入れ直してください。');
  }

  async function restartNow() {
    if (typeof isBusy === 'function' && isBusy()) return toast('いまの処理が終わってから、もう一度押してください。', 'error');
    const ok = await confirmDialog({ title: '再起動して更新しますか？', message: 'アプリがいったん閉じて、更新が終わると自動で開き直します。\n作業中のファイルや、記録した内容は変わりません。', okLabel: '再起動して更新' });
    if (!ok) return;
    try { await APP('installUpdate'); } catch (e) { showError(e); }
  }

  function showNotes() {
    if (!st) return;
    modal({ title: `🆕 ${st.version ? 'v' + st.version : '新しい版'} の更新内容`, wide: true,
      body: h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '50vh', overflow: 'auto', margin: 0 } }, st.notes || '（更新内容の説明はありません）'),
      buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
  }

  /** 「新しい版を確認」：結果を、画面の通知でもはっきり伝える */
  async function checkNow() {
    const r = await withBusy('新しい版を確認中…', () => APP('checkForUpdates'));
    if (!r) return null;
    apply(r);
    if (r.status === 'disabled') toast(r.reason || '更新の確認は使えません。');
    else if (r.error) toast(r.error, 'error');
    else if (r.status === 'uptodate' || r.status === 'idle') toast(`最新の版です ✓（v${r.currentVersion}）`);
    else if (active(r)) { reopen(); }
    return r;
  }

  async function init() {
    const link = document.getElementById('updateLink');
    if (link) link.onclick = reopen;
    try { if (api.onUpdateState) api.onUpdateState((s) => apply(s)); } catch (_) { /* 無視 */ }
    try { apply(await APP('updateState')); } catch (_) { /* 古いテスト環境など */ }
  }

  return { init, state, bind, checkNow, startUpdate, restartNow, showNotes, reopen };
})();
