'use strict';

/** Choose a short, actionable next step for common Git/GitHub failures. */
function recoveryGuidance(error) {
  const text = `${error?.message || ''}\n${error?.detail || ''}`;
  if (/CONFLICT|ぶつかり|merge conflict|could not apply/i.test(text)) {
    return { title: '変更のぶつかりを解決', steps: ['「変更」画面でぶつかったファイルを確認します。', '採用する内容を選んで保存し、合流を続けます。', 'やり直したい場合は、同じ画面の「合流を中止」を選びます。'], view: 'changes', button: '変更を確認する' };
  }
  if (/non-fast-forward|fetch first|最新を取り込む|remote contains work/i.test(text)) {
    return { title: 'サーバーの更新を取り込む', steps: ['上部の「最新を取り込む」で相手の更新を受け取ります。', 'ぶつかりが出た場合は「変更」画面で解決します。', '解決後、もう一度アップロードします。'], view: 'changes', button: '変更を確認する' };
  }
  if (error?.kind) {
    return { title: 'GitHubへのログインを確認', steps: ['ログイン案内に従って認証を更新します。', '作業中の変更や記録はそのまま残ります。', '更新後、元の操作をもう一度実行します。'], view: 'github', button: 'GitHubを開く' };
  }
  if (/403|権限|permission|招待|denied|not found/i.test(text)) {
    return { title: '共有先と権限を確認', steps: ['GitHubのプロジェクト名と接続先を確認します。', '「チーム」で招待が届いていないか確認します。', 'アクセスできることを確認してから、もう一度操作します。'], view: 'team', button: 'チームを確認する' };
  }
  if (/Could not resolve host|network|ネットワーク|timed out|接続できません/i.test(text)) {
    return { title: '接続を確認して再試行', steps: ['インターネット接続を確認します。', '復旧したら、上部の「まとめて更新」から状態を確認します。', '送信が完了したか分からない場合は、先に「履歴」を確認します。'], view: 'history', button: '履歴を確認する' };
  }
  return { title: '状態を確認してからやり直す', steps: ['「変更」画面で、作業中のファイルと記録を確認します。', '必要なら履歴や一時退避から状態を確認します。', '原因を直してから、同じ操作をもう一度試します。'], view: 'changes', button: '変更を確認する' };
}

if (typeof module !== 'undefined' && module.exports) module.exports = recoveryGuidance;
