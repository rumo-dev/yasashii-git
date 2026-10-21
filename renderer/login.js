'use strict';
/* GitHub ログインの必須化：ログインが済むまで、他の画面には進めない「入り口の画面」 */

let _onLoginCode = null;
let _codeListenerSet = false;

/**
 * ログイン済みになるまで入り口の画面を表示する。ログインできたら、その状態（{ login, ... }）で解決する。
 * すでにログイン済みなら、画面は出さずにそのまま解決する。
 */
function requireLogin({ reason = '' } = {}) {
  return new Promise((resolve) => {
    const view = clear($('#view'));
    showShell(false);
    if (!_codeListenerSet) { _codeListenerSet = true; api.onGhLoginCode((c) => { if (_onLoginCode) _onLoginCode(c); }); }

    const card = h('div', { class: 'gate' });
    view.appendChild(card);
    let waiting = false; // ブラウザでの認証待ち
    let session = 0;

    async function recheck(note) {
      draw({ checking: true });
      let a;
      try { a = await GH('authStatus'); } catch (e) { a = { installed: false, loggedIn: false, message: e.message }; }
      if (a.installed && a.loggedIn) { S.auth = a; resolve(a); return; }
      draw({ auth: a, note: a.expired ? '前回のログインの有効期限が切れています。もう一度ログインしてください。' : (note || '') });
    }

    function head() {
      return [
        h('div', { class: 'gate-logo' }, '🌱'),
        h('h1', {}, 'やさしいGit'),
        h('p', { class: 'sub' }, 'はじめに、GitHubにログインしてください。ログインすると、アップロードやダウンロードがボタンひとつでできます。'),
        reason ? h('p', { class: 'muted', style: { marginTop: 0 } }, reason) : null,
      ].filter(Boolean);
    }

    function draw({ checking = false, auth = null, note = '' } = {}) {
      clear(card).append(...head());
      if (checking) { card.appendChild(h('div', { class: 'empty' }, '確認中…')); return; }
      if (note) card.appendChild(h('div', { class: 'danger-note', style: { marginBottom: '12px' } }, note));

      if (auth && !auth.installed) { card.appendChild(installBox()); return; }
      card.appendChild(waiting ? waitingBox() : loginBox());
    }

    /* ---- 手順1：GitHub CLI がない ---- */
    function installBox() {
      return h('div', { class: 'card' },
        h('h3', {}, '① 準備：GitHub CLI（無料）のインストール'),
        h('p', { class: 'muted' }, 'GitHubとやりとりするための小さな部品が、まだこのパソコンにありません。'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary big', onclick: async () => { if (await installGhFlow()) recheck(); } }, '⬇ インストールする'),
          h('button', { class: 'btn', onclick: () => APP('openExternal', 'https://cli.github.com/') }, 'ダウンロードページを開く'),
          h('button', { class: 'btn', onclick: () => recheck() }, '🔄 インストールしたので、もう一度確認')));
    }

    /* ---- 手順2：ログイン ---- */
    function loginBox() {
      const tokenInput = h('input', { type: 'password', placeholder: 'ghp_xxxxxxxxxxxx', class: 'code-input' });
      return h('div', {},
        h('div', { class: 'card' },
          h('h3', {}, 'ブラウザでログイン（かんたん）'),
          h('p', { class: 'muted' }, 'ボタンを押すとブラウザが開きます。表示される確認コードを入力して「許可」を押すだけです。'),
          h('button', { class: 'btn primary big', onclick: startWebLogin }, '🌐 GitHubにログインする'),
          h('p', { class: 'muted', style: { fontSize: '12px', marginBottom: 0 } }, 'GitHubのアカウントがない方は ',
            h('button', { class: 'link', onclick: () => APP('openExternal', 'https://github.com/signup') }, 'こちらから無料で作れます'), '。')),
        h('details', { class: 'card' },
          h('summary', {}, 'ブラウザでうまくいかないとき（トークンでログイン）'),
          h('p', { class: 'muted' }, 'GitHubで発行した「アクセストークン」を貼り付けてもログインできます。（権限：repo, read:org, workflow）'),
          h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, h('button', { class: 'btn small', onclick: () => APP('openExternal', 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=yasashii-git') }, 'トークンの発行ページを開く')),
          h('label', { class: 'field' }, h('span', {}, 'アクセストークン'), tokenInput),
          h('button', { class: 'btn', onclick: async () => {
            const r = await withBusy('ログイン中…', () => GH('loginWithToken', null, tokenInput.value));
            if (r && r.loggedIn) { S.auth = r; resolve(r); } else if (r) toast('ログインできませんでした。トークンを確認してください。', 'error');
          } }, 'トークンでログイン')));
    }

    function waitingBox() {
      const codeBox = h('div', { class: 'mono gate-code' }, '…');
      _onLoginCode = (c) => { codeBox.textContent = c; };
      return h('div', { class: 'card' },
        h('h3', {}, 'ブラウザでコードを入力してください'),
        h('p', { class: 'muted' }, 'GitHubのページが開いたら、次のコードを入力して「許可」を押してください。完了すると自動で次へ進みます。'),
        codeBox,
        h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn', onclick: () => { APP('copyText', codeBox.textContent).catch(() => {}); toast('コードをコピーしました'); } }, '📋 コードをコピー'),
          h('button', { class: 'btn', onclick: () => APP('openExternal', 'https://github.com/login/device') }, '🌐 ブラウザを開き直す'),
          h('button', { class: 'btn ghost', onclick: cancelWebLogin }, 'キャンセル')));
    }

    async function startWebLogin() {
      const my = ++session;
      waiting = true; draw({ auth: { installed: true } });
      try {
        const r = await api.ghLoginWeb();
        if (my !== session) return;
        waiting = false;
        if (r && r.loggedIn) { S.auth = r; toast('ログインしました 🎉'); resolve(r); return; }
        recheck('ログインを確認できませんでした。もう一度お試しください。');
      } catch (e) {
        if (my !== session) return; // キャンセル済み・やり直し済み
        waiting = false;
        draw({ auth: { installed: true } });
        showError(e);
      }
    }
    async function cancelWebLogin() {
      session++; waiting = false;
      GH('cancelLogin').catch(() => {});
      draw({ auth: { installed: true } });
    }

    recheck();
  });
}
