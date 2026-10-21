'use strict';
/**
 * 用語辞書：Git用語 → 初心者向けのやさしい日本語。
 * ja = 画面に出す言い方 / en = 元のGit用語 / hint = 説明
 */
const TERMS = {
  repository: { ja: 'プロジェクト', en: 'repository', hint: 'ファイルとその変更の記録をまとめて管理するフォルダです。' },
  commit:     { ja: '変更を記録', en: 'commit', hint: '今の状態を「セーブポイント」として残します。あとでいつでも戻れます。' },
  commitNoun: { ja: '記録', en: 'commit', hint: 'セーブポイント1つぶんの変更のことです。' },
  message:    { ja: '記録のメモ', en: 'commit message', hint: '何を変えたか、あとで見て分かる短い説明を書きます。' },
  push:       { ja: 'アップロード', en: 'push', hint: '手元の記録をGitHubなどのサーバーへ送ります。' },
  pull:       { ja: '最新を取り込む', en: 'pull', hint: 'サーバーにある最新の更新を、手元へ取り込みます。' },
  fetch:      { ja: '更新を確認', en: 'fetch', hint: 'サーバーに新しい更新があるか確認します（手元のファイルは変わりません）。' },
  clone:      { ja: 'ダウンロードして始める', en: 'clone', hint: 'GitHubなどにあるプロジェクトを、手元にコピーして使い始めます。' },
  init:       { ja: '新しく作る', en: 'init', hint: '今のフォルダを、変更を記録できるプロジェクトにします。' },
  branch:     { ja: '作業の分岐', en: 'branch', hint: '本流に影響を与えずに、別の作業を進めるための分岐です。' },
  merge:      { ja: '合流', en: 'merge', hint: '別の分岐の作業内容を、今の分岐に取り込みます。' },
  stage:      { ja: '記録に含める', en: 'stage / add', hint: '次の「記録」に入れるファイルを選びます。' },
  unstage:    { ja: '記録から外す', en: 'unstage', hint: '次の「記録」に入れるのをやめます（ファイルは消えません）。' },
  stash:      { ja: '一時退避', en: 'stash', hint: '作業途中の変更をいったん脇へしまい、ファイルをきれいな状態に戻します。' },
  tag:        { ja: '目印', en: 'tag', hint: 'バージョン1.0のように、特定の記録に名前をつけて目印にします。' },
  switch:     { ja: '切り替え', en: 'switch / checkout', hint: '作業する分岐を変えます。' },
  discard:    { ja: '変更を破棄', en: 'discard', hint: '加えた変更を捨てて、最後の記録の状態に戻します。元に戻せません。' },
  remote:     { ja: '接続先', en: 'remote', hint: 'GitHubなど、アップロード・取り込みの相手先です。' },
  conflict:   { ja: 'ぶつかり', en: 'conflict', hint: '同じ場所を別々に変更したため、どちらを採用するか決める必要がある状態です。' },
  revert:     { ja: '取り消しの記録を作る', en: 'revert', hint: '過去の記録の変更を打ち消す、新しい記録を作ります。履歴は消えず安全です。' },
  reset:      { ja: 'ここまで巻き戻す', en: 'reset', hint: '作業の分岐の先頭を、過去の記録の位置まで戻します。' },
  cherryPick: { ja: 'この記録だけコピー', en: 'cherry-pick', hint: '別の分岐の特定の記録だけを、今の分岐にコピーします。' },
  amend:      { ja: '直前の記録を修正', en: 'amend', hint: '直前の記録のメモや内容を直します（アップロード前に使うと安全です）。' },
  diff:       { ja: '変更内容', en: 'diff', hint: '何行目が追加・削除されたかを表示します。' },
  head:       { ja: '今いる場所', en: 'HEAD', hint: '今作業している記録の位置です。' },
  upstream:   { ja: 'アップロード先の分岐', en: 'upstream', hint: '手元の分岐と結びついている、サーバー側の分岐です。' },
  untracked:  { ja: '新しいファイル', en: 'untracked', hint: 'まだ一度も記録されていないファイルです。' },
  gitignore:  { ja: '管理しないファイルの一覧', en: '.gitignore', hint: '記録の対象にしたくないファイル（パスワード、一時ファイルなど）を指定します。' },
  pr:         { ja: '変更の提案', en: 'pull request', hint: '「この作業を本流に取り込んでください」とチームへお願いする仕組みです。' },
  issue:      { ja: '課題・相談', en: 'issue', hint: 'バグの報告や、やりたいことの相談を書き込む場所です。' },
  detached:   { ja: '過去の記録を見ている状態', en: 'detached HEAD', hint: '分岐の上ではなく、過去の特定の記録を見ています。ここで記録すると迷子になりやすいので、分岐に戻りましょう。' },
  member:     { ja: 'メンバー', en: 'collaborator', hint: 'そのプロジェクトをいっしょに作業できる人です。' },
  invite:     { ja: '招待', en: 'invitation', hint: '「いっしょに作業しませんか」というお誘いです。相手が「参加する」を押すとメンバーになります。' },
  roleWrite:  { ja: '編集できる', en: 'write', hint: 'ファイルの変更をアップロードできます。いっしょに作る人はこれを選びます。' },
  roleRead:   { ja: '見るだけ', en: 'read', hint: '中身を見たりダウンロードしたりできますが、変更はアップロードできません。' },
  roleAdmin:  { ja: '管理者', en: 'admin', hint: 'メンバーの招待や削除など、プロジェクトの設定もできます。' },
  shareLink:  { ja: '共有リンク', en: 'URL', hint: 'このプロジェクトのGitHubのアドレスです。チームの人に送ると、「リンクで参加」から始められます。' },
  force:      { ja: '強制アップロード', en: 'force push', hint: 'サーバー側の履歴を上書きします。他の人の作業が消える可能性があり、危険です。' },
};

const settingsRef = { showOriginal: true };
/** 画面に出す言い方 */
function jp(key) { return TERMS[key] ? TERMS[key].ja : key; }
/** やさしい言い方 + (元の用語) の文字列 */
function jpEn(key) { const t = TERMS[key]; return settingsRef.showOriginal ? `${t.ja}（${t.en}）` : t.ja; }
function hint(key) { return TERMS[key] ? TERMS[key].hint : ''; }
