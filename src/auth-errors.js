'use strict';
/**
 * 「ログインが切れた／SSH鍵で入れない」系のエラーを見分ける。
 *   'ssh'  … SSH鍵・ホスト鍵まわりの失敗（git@github.com:… 形式の接続先）
 *   'scope' … ログインはできているが、権限（workflow）が足りない（.github/workflows のファイルを送るときなど）
 *   'auth' … HTTPS のトークン切れ・取り消し・認証情報の食い違い
 *   ''     … それ以外（ネットワーク断・権限不足(403)・ぶつかり など。ログインし直しても直らないもの）
 *
 * 画面側はこの種類を見て、その場で「再ログイン」や「HTTPS形式への切り替え」へ案内する。
 * 403（権限がない）は、ログインし直しても直らないので含めない。
 */
const SSH_RE = /Permission denied \(publickey|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key type|Load key .*: (?:invalid format|bad permissions)|Too many authentication failures|sign_and_send_pubkey|Could not read from remote repository[\s\S]*(?:publickey|Permission denied)/i;

// ログインの権限（スコープ）が足りない：例）refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope
const SCOPE_RE = /without [`'"]?workflow[`'"]? scope|requires the [`'"]?workflow[`'"]? scope|workflow[`'"]? scope/i;

const AUTH_RE = /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|Invalid username or token|Password authentication is not supported|Support for password authentication was removed|Bad credentials|HTTP 401|returned error: 401|error: 401|requires authentication|gh auth login|not logged in|authentication required|token.{0,30}(?:expired|revoked|invalid)|(?:expired|revoked|invalid).{0,30}token|The token in .* is invalid/i;

// ネットワークが原因のときは、ログインし直しても直らない（文面に認証っぽい語が混ざっていても誤検知しない）
const NETWORK_RE = /Could not resolve host|Failed to connect|Network is unreachable|Connection timed out|Connection refused|dial tcp|early EOF|RPC failed/i;

function classifyAuth(text) {
  const s = String(text || '');
  if (!s) return '';
  if (SCOPE_RE.test(s)) return 'scope';
  if (SSH_RE.test(s)) return 'ssh';
  if (NETWORK_RE.test(s)) return '';
  if (AUTH_RE.test(s)) return 'auth';
  return '';
}

module.exports = { classifyAuth };
