'use strict';
/**
 * アップロード前の安全チェックの「検出ルール」（Gitに依存しない純粋なロジック）。
 *  - 秘密情報を含みやすいファイル名（.env・秘密鍵など）
 *  - 中身に書かれたパスワード・APIキー・秘密鍵
 *  - 大きすぎるファイル（GitHubは 100MB 超を拒否、50MB 超は警告）
 *
 * level: 'block'  = GitHubが受け付けないので送れない
 *        'danger' = 送ると秘密情報が漏れるおそれが高い
 *        'warn'   = 念のための注意（見間違いの可能性もある）
 */
const MB = 1024 * 1024;
const LIMIT_BLOCK = 100 * MB;
const LIMIT_WARN = 50 * MB;

const NAME_RULES = [
  { re: /^\.env(\..+)?$/i, skip: /\.(example|sample|template|dist|defaults?)$/i, label: '環境設定ファイル（.env）', why: 'パスワードやAPIキーが書かれていることが多いファイルです。' },
  { re: /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, label: 'SSHの秘密鍵', why: '他人に渡してはいけない「合いかぎ」です。' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, label: '鍵・証明書のファイル', why: '秘密鍵が入っていることがあります。' },
  { re: /^service[-_]?account.*\.json$/i, label: 'サービスアカウントの鍵', why: 'クラウドの操作権限を持つ鍵です。' },
  { re: /^(credentials|secrets?)\.(json|ya?ml|toml|ini|txt)$/i, label: '認証情報のファイル', why: 'ログインに使う情報が書かれていることが多いファイルです。' },
  { re: /^\.(npmrc|pypirc|netrc|git-credentials)$/, label: '認証情報を含みやすい設定ファイル', why: 'トークンやパスワードが書かれていることがあります。' },
  { re: /^terraform\.tfstate(\.backup)?$/, label: 'Terraformの状態ファイル', why: '秘密情報がそのまま入っていることがあります。' },
];

const CONTENT_RULES = [
  { id: 'private-key', level: 'danger', label: '秘密鍵', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws', level: 'danger', label: 'AWSのアクセスキー', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github', level: 'danger', label: 'GitHubのトークン', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: 'slack', level: 'danger', label: 'Slackのトークン', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'google', level: 'danger', label: 'Google APIキー', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe', level: 'danger', label: 'Stripeの本番キー', re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/ },
  { id: 'sk', level: 'danger', label: 'APIキー（sk-…）', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },
  // DB_PASSWORD = "..." / client_secret: "..." / MY_API_KEY='...' など（前後に英字が続く単語、例：passenger・bypass は対象外）
  { id: 'generic', level: 'warn', label: 'パスワードやキーらしき記述',
    re: /(?<![A-Za-z])(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(?![A-Za-z])[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    ignoreValue: /^(your|xxx|changeme|change-me|example|dummy|sample|test|placeholder|<|\$\{|\{\{|%|\*{3,}|\.{3})/i },
  // dbPassword = "..." / clientSecret: "..." などの camelCase
  { id: 'generic-camel', level: 'warn', label: 'パスワードやキーらしき記述',
    re: /[a-z](?:Password|Passwd|Secret|ApiKey|AccessToken|AuthToken)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/,
    ignoreValue: /^(your|xxx|changeme|change-me|example|dummy|sample|test|placeholder|<|\$\{|\{\{|%|\*{3,}|\.{3})/i },
];

/** ファイル名が「秘密情報を含みやすい」ものなら、その説明を返す（違えば null） */
function checkName(filePath) {
  const base = String(filePath || '').split('/').pop();
  for (const r of NAME_RULES) if (r.re.test(base) && !(r.skip && r.skip.test(base))) return { label: r.label, why: r.why };
  return null;
}

/** ファイルサイズの判定。'block' | 'warn' | null */
function checkSize(bytes) {
  if (bytes >= LIMIT_BLOCK) return 'block';
  if (bytes >= LIMIT_WARN) return 'warn';
  return null;
}

/** 1行の中身を調べる。見つかったルール（label/level/id）を返す（秘密の値そのものは返さない） */
function checkLine(line) {
  if (line.length > 2000) line = line.slice(0, 2000); // 圧縮されたファイルなどで時間がかからないように
  for (const r of CONTENT_RULES) {
    const m = r.re.exec(line);
    if (!m) continue;
    if (r.ignoreValue && m[1] && r.ignoreValue.test(m[1])) continue;
    return { id: r.id, level: r.level, label: r.label };
  }
  return null;
}

const fmtSize = (b) => (b >= MB ? (b / MB).toFixed(b >= 10 * MB ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

module.exports = { MB, LIMIT_BLOCK, LIMIT_WARN, checkName, checkSize, checkLine, fmtSize };
