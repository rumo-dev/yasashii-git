'use strict';
/**
 * ログイン切れ・SSH鍵エラーの自動復旧。
 *
 * 操作が「認証エラー」で失敗したとき（e.kind が 'auth' か 'ssh'）、エラーの箱を出して終わりにせず、
 * その場で再ログイン（または HTTPS 形式への切り替え）へ案内し、終わったら元の操作を1回だけ自動でやり直す。
 *   - withBusy / withBusyThrow（ui.js）は、失敗した操作を recoverAuth に渡して、'retry' ならやり直す
 *   - showError（ui.js）は、やり直せない場面（一覧の読み込みなど）で、案内だけ出して「もう一度操作してください」と伝える
 *   - 操作していないときも、一定時間ごとにログインの有効期限を確認する（authWatchTick）
 * recoverAuth の戻り値： 'retry'（直ったのでやり直してよい） / 'declined'（本人が「あとで」を選んだ） / 'not-auth'（認証の問題ではない）
 */

let _recovering = null;     // 案内を出している間は、同時にもう1つ出さない（待っている呼び出しにも同じ結果を返す）
let _lastCredRefresh = 0;   // git のログイン情報を直近で設定し直した時刻（同じ手を何度も繰り返さない）
let _lastAuthCheck = 0;

const isAuthError = (e) => !!(e && (e.kind === 'auth' || e.kind === 'ssh' || e.kind === 'scope'));

function recoverAuth(e) {
  // ログイン画面の最中（S.auth が空）は対象外。ログイン操作そのものの失敗で案内を重ねない
  if (!isAuthError(e) || !S.auth) return Promise.resolve('not-auth');
  if (_recovering) return _recovering;
  _recovering = (e.kind === 'ssh' ? recoverSsh() : e.kind === 'scope' ? recoverScope() : recoverToken()).finally(() => { _recovering = null; });
  return _recovering;
}

async function loginState() { try { return await GH('authStatus'); } catch (_) { return null; } }
const loginValid = (st) => !!(st && st.installed && st.loggedIn && !st.expired);

/** もう一度ログインしてもらう。force: ログインは有効に見えるのに認証が通らないとき、いったんログアウトして入れ直す */
async function reauth({ force = false } = {}) {
  const was = S.repo; const view = S.view;
  if (force) { try { await GH('logout'); } catch (_) { /* すでに無効でもよい */ } }
  S.auth = null;
  await requireLogin({ reason: 'ログインし直すと、さっきの操作をそのまま続けられます。' });
  await ensureGitUser({ notify: false });
  if (was) { showShell(true); buildNav(); go(view, true); updateChrome(); refreshStatus(true); }
  else renderWelcome();
}

/* ---- HTTPS のトークン切れ・認証情報の食い違い ---- */
async function recoverToken() {
  const st = await loginState();
  const valid = loginValid(st);
  // gh のログインは有効なのに git が通らない → git が使うログイン情報の食い違い（古い保存済みパスワードなど）。まず静かに設定し直して再試行
  if (valid && Date.now() - _lastCredRefresh > 60000) {
    _lastCredRefresh = Date.now();
    try { await GH('refreshGitCredentials'); toast('ログイン情報を設定し直しました。もう一度試します…'); return 'retry'; }
    catch (_) { /* だめなら、下の案内へ */ }
  }
  const body = h('div', {},
    h('p', { style: { marginTop: 0 } }, valid
      ? 'GitHubへの認証が通りませんでした。ログイン情報が古くなっているか、取り消されている可能性があります。'
      : 'GitHubのログインの有効期限が切れたか、アクセストークンが取り消されたようです。'),
    h('p', { class: 'muted', style: { marginBottom: 0 } }, 'ログインし直せば、そのまま作業を続けられます。作業中のファイルや、まだ送っていない記録は消えません。'));
  const r = await modal({ title: '🔑 GitHubにログインし直してください', body, buttons: [{ label: 'あとで', value: 'later' }, { label: '🔑 ログインし直す', kind: 'primary', value: 'go' }] });
  if (r !== 'go') { toast('あとでログインし直してください。', 'error'); return 'declined'; }
  await reauth({ force: valid });
  return 'retry';
}

/* ---- ログインはできているが、権限（workflow）が足りない ---- */
async function recoverScope() {
  const body = h('div', {},
    h('p', { style: { marginTop: 0 } }, 'このプロジェクトには、自動ビルドの設定ファイル（.github/workflows）が入っています。これをGitHubへ送るには、ログイン時に「ワークフロー」の権限が必要ですが、いまのログインには含まれていません。'),
    h('p', { class: 'muted', style: { marginBottom: 0 } }, 'ログインし直すと、必要な権限つきでログインできます。作業中のファイルや、まだ送っていない記録は消えません。'));
  const r = await modal({ title: '🔑 ログインの権限が足りません', body, buttons: [{ label: 'あとで', value: 'later' }, { label: '🔑 ログインし直す', kind: 'primary', value: 'go' }] });
  if (r !== 'go') { toast('権限が足りないため、アップロードできていません。', 'error'); return 'declined'; }
  await reauth({ force: true });
  return 'retry';
}

/* ---- SSH鍵で入れない ---- */
async function recoverSsh() {
  const remotes = S.repo ? await G('remotes').catch(() => []) : [];
  const targets = remotes.filter((r) => sshToHttps(r.fetchUrl) || sshToHttps(r.pushUrl || ''));
  if (!targets.length) return 'not-auth'; // 切り替えられる接続先がない（やさしい日本語の説明つきの通常のエラーを出す）
  const body = h('div', {},
    h('p', { style: { marginTop: 0 } }, 'このプロジェクトは「SSH鍵」を使う形式でGitHubにつながっていますが、鍵で入れませんでした。（鍵の期限切れ・未登録・変更など）'),
    h('p', {}, 'このアプリでログインしているGitHubアカウントをそのまま使える「HTTPS形式」に切り替えると、鍵なしで使えます。フォルダの中身や履歴は変わりません。'),
    h('div', { class: 'list', style: { marginBottom: '8px' } }, targets.map((r) => h('div', { class: 'row' }, h('b', {}, r.name), h('div', { class: 'grow mono title', style: { fontSize: '12px' } }, `${r.fetchUrl}  →  ${sshToHttps(r.fetchUrl) || sshToHttps(r.pushUrl)}`)))));
  const r = await modal({ title: '🔑 SSH鍵で接続できませんでした', body, buttons: [{ label: 'あとで', value: 'later' }, { label: '🔁 HTTPS形式に切り替えて続ける', kind: 'primary', value: 'go' }] });
  if (r !== 'go') { toast('接続できないままです。「設定」画面の接続先から変更もできます。', 'error'); return 'declined'; }
  try { for (const t of targets) await G('setRemoteUrl', t.name, sshToHttps(t.fetchUrl) || sshToHttps(t.pushUrl)); }
  catch (_) { return 'not-auth'; }
  const st = await loginState();
  if (loginValid(st)) { try { await GH('refreshGitCredentials'); } catch (_) { /* 無視 */ } }
  else await reauth();
  toast('HTTPS形式に切り替えました ✓');
  return 'retry';
}

/** 失敗した操作を渡すと、認証エラーのときだけ案内→1回だけやり直す。やり直せないときは、元のエラーをそのまま投げる */
async function withAuthRecovery(fn, { onPause = () => {}, onResume = () => {} } = {}) {
  try { return await fn(); }
  catch (e) {
    if (!isAuthError(e)) throw e;
    onPause();
    let r;
    try { r = await recoverAuth(e); } finally { onResume(); }
    if (r === 'retry') {
      try { return await fn(); }
      catch (e2) { if (e2 && typeof e2 === 'object') e2.authHandled = true; throw e2; } // 2回目の失敗では、案内をくり返さない
    }
    e.authHandled = true;
    if (r === 'declined') e.cancelled = true; // 本人が選んだ結果なので、エラーの箱は重ねない
    throw e;
  }
}

/* ---- 操作していない間の見張り ---- */
const AUTH_WATCH_MS = 10 * 60 * 1000;
const AUTH_SNOOZE_MS = 60 * 60 * 1000; // 「あとで」を選ばれたら、しばらく見張りの案内は出さない
let _watchSnoozeUntil = 0;
async function authWatchTick() {
  if (!S.auth || isBusy() || _recovering || Date.now() < _watchSnoozeUntil) return;
  _lastAuthCheck = Date.now();
  const st = await loginState();
  if (!st || !st.installed || st.loggedIn || !S.auth || isBusy()) return; // 通信できないときなどは黙って次回へ
  if ((await recoverAuth({ kind: 'auth' })) === 'declined') _watchSnoozeUntil = Date.now() + AUTH_SNOOZE_MS;
}
function startAuthWatch() {
  setInterval(() => { authWatchTick().catch(() => {}); }, AUTH_WATCH_MS);
  window.addEventListener('focus', () => { if (Date.now() - _lastAuthCheck > AUTH_WATCH_MS) authWatchTick().catch(() => {}); });
}
