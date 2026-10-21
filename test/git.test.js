'use strict';
// Git操作層の自動テスト（node 組み込みの assert のみ。実際の git を一時フォルダで動かす）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const U = require('../renderer/util');
const safety = require('../src/safety');

let passed = 0;
// Windows の改行自動変換（core.autocrlf）に影響されないよう、読み込み時に改行をそろえる
const R = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.stack || e, e.detail || ''); process.exitCode = 1; }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yg-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home);
  process.env.HOME = home; process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
  const W = (r, f, c) => { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), c); };

  const repo = path.join(tmp, 'proj');
  const bare = path.join(tmp, 'remote.git');

  console.log('Git操作層テスト');
  await t('init: main 分岐で初期化される', async () => {
    await git.init(repo);
    const st = await git.status(repo);
    assert.strictEqual(st.branch, 'main');
    assert.strictEqual(st.hasCommits, false);
  });

  await t('名前未設定の記録は日本語エラー', async () => {
    W(repo, 'a.txt', 'one\n');
    await git.stage(repo, ['a.txt']);
    await git.run(['config', '--global', '--unset', 'user.name'], { cwd: repo, okCodes: [0, 1, 5] });
    await git.run(['config', '--local', 'user.useConfigOnly', 'true'], { cwd: repo });
    await assert.rejects(() => git.commit(repo, { summary: 'x' }), (e) => /名前.*メール/.test(e.message));
    await git.run(['config', '--local', '--unset', 'user.useConfigOnly'], { cwd: repo });
  });

  await t('ユーザー設定と最初の記録', async () => {
    await git.setUser(repo, { name: 'テスト太郎', email: 't@example.com', global: false });
    const u = await git.getUser(repo);
    assert.strictEqual(u.name, 'テスト太郎');
    await git.commit(repo, { summary: '最初の記録', body: '詳細メモ' });
    const l = await git.log(repo);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].subject, '最初の記録');
    assert.strictEqual(l[0].body, '詳細メモ');
  });

  await t('status: 変更・新規・日本語ファイル名・空白入りパス', async () => {
    W(repo, 'a.txt', 'one\ntwo\n');
    W(repo, '日本語 ファイル.txt', 'こんにちは\n');
    const st = await git.status(repo);
    const a = st.files.find((f) => f.path === 'a.txt');
    const j = st.files.find((f) => f.path === '日本語 ファイル.txt');
    assert.ok(a && a.unstaged && !a.staged && a.workLabel === '変更');
    assert.ok(j && j.untracked && j.workLabel === '新規');
  });

  await t('diff: 変更・新規ファイル', async () => {
    const d1 = await git.diff(repo, { path: 'a.txt' });
    assert.match(d1, /\+two/);
    const d2 = await git.diff(repo, { path: '日本語 ファイル.txt', untracked: true });
    assert.match(d2, /\+こんにちは/);
    assert.ok(!d2.includes(repo), '絶対パスが残っていない');
  });

  await t('stage / unstage / 部分的な記録(applyPatch)', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    W(repo, 'big.txt', lines); await git.stage(repo, ['big.txt']); await git.commit(repo, { summary: 'big' });
    const edited = lines.replace('line2\n', 'LINE2\n').replace('line29\n', 'LINE29\n');
    W(repo, 'big.txt', edited);
    const d = await git.diff(repo, { path: 'big.txt', context: 1 });
    const parts = d.split(/^(?=@@ )/m);
    assert.strictEqual(parts.length, 3, '2つのかたまりに分かれる');
    await git.applyPatch(repo, parts[0] + parts[1], { cached: true });
    let st = await git.status(repo);
    const f = st.files.find((x) => x.path === 'big.txt');
    assert.ok(f.staged && f.unstaged, '一部だけ記録対象');
    const cached = await git.diff(repo, { path: 'big.txt', staged: true });
    assert.match(cached, /\+LINE2\n/); assert.ok(!/LINE29/.test(cached));
    await git.unstage(repo, ['big.txt']);
    await git.discard(repo, [{ path: 'big.txt' }]);
    assert.strictEqual(R(path.join(repo, 'big.txt')), lines);
  });

  await t('discard: 変更と新規ファイルの破棄', async () => {
    await git.discard(repo, [{ path: 'a.txt' }, { path: '日本語 ファイル.txt', untracked: true }]);
    const st = await git.status(repo);
    assert.strictEqual(st.files.length, 0);
    assert.strictEqual(R(path.join(repo, 'a.txt')), 'one\n');
  });

  await t('接続先 → アップロード（初回は自動で結びつく）→ 取り込み', async () => {
    await git.run(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
    await assert.rejects(() => git.push(repo), (e) => /接続先/.test(e.message));
    await git.addRemote(repo, 'origin', bare);
    await git.push(repo);
    let st = await git.status(repo);
    assert.strictEqual(st.upstream, 'origin/main');
    assert.strictEqual(st.ahead, 0);
    // 別の人が更新
    const other = path.join(tmp, 'other');
    await git.clone(null, bare, tmp, 'other');
    await git.setUser(other, { name: '花子', email: 'h@example.com', global: false });
    W(other, 'b.txt', 'from other\n'); await git.stage(other, ['b.txt']); await git.commit(other, { summary: '花子の更新' }); await git.push(other);
    await git.fetch(repo);
    st = await git.status(repo);
    assert.strictEqual(st.behind, 1);
    // 先に取り込まず記録→アップロードすると日本語で案内
    W(repo, 'c.txt', 'mine\n'); await git.stage(repo, ['c.txt']); await git.commit(repo, { summary: '私の更新' });
    await assert.rejects(() => git.push(repo), (e) => /最新を取り込む/.test(e.message));
    const r = await git.pull(repo);
    assert.strictEqual(r.conflict, false);
    await git.push(repo);
    st = await git.status(repo);
    assert.strictEqual(st.ahead, 0); assert.strictEqual(st.behind, 0);
  });

  await t('ブランチ: 作成・切替・合流・ぶつかり解決・削除', async () => {
    await git.createBranch(repo, 'feature');
    W(repo, 'a.txt', 'feature side\n'); await git.stage(repo, ['a.txt']); await git.commit(repo, { summary: 'feature変更' });
    await git.switchBranch(repo, 'main');
    W(repo, 'a.txt', 'main side\n'); await git.stage(repo, ['a.txt']); await git.commit(repo, { summary: 'main変更' });
    const m = await git.merge(repo, 'feature');
    assert.strictEqual(m.conflict, true);
    let st = await git.status(repo);
    assert.strictEqual(st.operation, 'merge');
    assert.ok(st.files.find((f) => f.conflict && f.path === 'a.txt'));
    await git.resolveConflict(repo, 'a.txt', 'theirs');
    await git.continueOperation(repo);
    st = await git.status(repo);
    assert.strictEqual(st.operation, null);
    assert.strictEqual(R(path.join(repo, 'a.txt')), 'feature side\n');
    await git.deleteBranch(repo, 'feature');
    const b = await git.branches(repo);
    assert.ok(b.local.some((x) => x.name === 'main' && x.current));
    assert.ok(!b.local.some((x) => x.name === 'feature'));
    assert.ok(b.remote.some((x) => x.name === 'origin/main'));
  });

  await t('合流の中止（abort）', async () => {
    await git.createBranch(repo, 'x1');
    W(repo, 'a.txt', 'x1\n'); await git.stage(repo, ['a.txt']); await git.commit(repo, { summary: 'x1' });
    await git.switchBranch(repo, 'main');
    W(repo, 'a.txt', 'm\n'); await git.stage(repo, ['a.txt']); await git.commit(repo, { summary: 'm' });
    assert.strictEqual((await git.merge(repo, 'x1')).conflict, true);
    await git.abortOperation(repo);
    const st = await git.status(repo);
    assert.strictEqual(st.operation, null); assert.strictEqual(st.files.length, 0);
    await git.deleteBranch(repo, 'x1', { force: true });
  });

  await t('履歴: 検索・詳細・取り消し(revert)', async () => {
    const l = await git.log(repo, { search: 'm$' });
    assert.ok(l.length >= 1);
    const all = await git.log(repo);
    const head = all[0];
    const files = await git.commitFiles(repo, head.hash);
    assert.ok(files.length >= 1 && files[0].path);
    const d = await git.commitDiff(repo, head.hash, files[0].path);
    assert.match(d, /@@/);
    const rv = await git.revertCommit(repo, head.hash);
    assert.strictEqual(rv.conflict, false);
    const after = await git.log(repo, { limit: 1 });
    assert.match(after[0].subject, /^Revert/);
  });

  await t('直前の記録の取り消しと修正', async () => {
    W(repo, 'z.txt', 'z\n'); await git.stage(repo, ['z.txt']); await git.commit(repo, { summary: 'z追加' });
    await git.undoLastCommit(repo);
    let st = await git.status(repo);
    assert.ok(st.files.find((f) => f.path === 'z.txt' && f.staged));
    await git.commit(repo, { summary: 'z追加(やり直し)' });
    await git.commit(repo, { summary: 'z追加(修正)', amend: true });
    assert.strictEqual((await git.lastCommitMessage(repo)).summary, 'z追加(修正)');
  });

  await t('一時退避（stash）: 退避・一覧・戻す', async () => {
    W(repo, 'a.txt', 'dirty\n'); W(repo, 'new.txt', 'n\n');
    await git.stashSave(repo, { message: '作業中メモ' });
    assert.strictEqual((await git.status(repo)).files.length, 0);
    const list = await git.stashList(repo);
    assert.strictEqual(list.length, 1); assert.match(list[0].subject, /作業中メモ/);
    assert.match(await git.stashDiff(repo, list[0].ref), /dirty/);
    await git.stashPop(repo, list[0].ref);
    assert.strictEqual((await git.status(repo)).files.length, 2);
    await assert.rejects(async () => { await git.discard(repo, [{ path: 'a.txt' }, { path: 'new.txt', untracked: true }]); await git.stashSave(repo); }, (e) => /退避する変更がありません/.test(e.message));
  });

  await t('目印（タグ）: 作成・一覧・アップロード・削除', async () => {
    await git.createTag(repo, 'v1.0', { message: '最初のリリース' });
    await git.createTag(repo, 'light');
    const ts = await git.tags(repo);
    assert.ok(ts.find((x) => x.name === 'v1.0' && x.annotated));
    assert.ok(ts.find((x) => x.name === 'light' && !x.annotated));
    await git.pushTag(repo, 'v1.0');
    await git.deleteRemoteTag(repo, 'v1.0');
    await git.deleteTag(repo, 'light');
    assert.strictEqual((await git.tags(repo)).length, 1);
  });

  await t('ブランチ名の検証・重複エラー', async () => {
    await assert.rejects(() => git.createBranch(repo, 'bad name'), (e) => /使えません/.test(e.message));
    await git.createBranch(repo, 'dup', { switchTo: false });
    await assert.rejects(() => git.createBranch(repo, 'dup', { switchTo: false }), (e) => /同じ名前/.test(e.message));
    await git.deleteBranch(repo, 'dup');
  });

  await t('リセット: 変更を残して巻き戻し', async () => {
    const all = await git.log(repo);
    await git.resetTo(repo, all[1].hash, 'keep');
    const l2 = await git.log(repo, { all: false });
    assert.strictEqual(l2[0].hash, all[1].hash);
  });

  await t('.gitignore の追記', async () => {
    await git.addIgnore(repo, 'node_modules/'); await git.addIgnore(repo, 'node_modules/');
    assert.strictEqual((await git.readIgnore(repo)).match(/node_modules\//g).length, 1);
  });

  await t('パス脱出を拒否', async () => {
    await assert.rejects(() => git.discard(repo, [{ path: '../outside', untracked: true }]), (e) => /外/.test(e.message));
  });

  await t('Git以外のフォルダの判定', async () => {
    const r = await git.checkRepo(tmp);
    assert.strictEqual(r.isRepo, false);
    assert.strictEqual((await git.checkRepo(repo)).isRepo, true);
  });

  await t('他のツールで取得したフォルダ（上流なし）：取り込み・アップロードで行き詰まらない', async () => {
    const bare2 = path.join(tmp, 'ext.git');
    await git.run(['init', '--bare', '-b', 'main', bare2], { cwd: tmp });
    const seed = path.join(tmp, 'seed'); await git.clone(null, bare2, tmp, 'seed');
    await git.setUser(seed, { name: 'S', email: 's@e.com', global: false });
    W(seed, 's.txt', '1\n'); await git.stage(seed, ['s.txt']); await git.commit(seed, { summary: 's1' }); await git.run(['push', 'origin', 'HEAD:main'], { cwd: seed });
    const mine = path.join(tmp, 'mine'); await git.clone(null, bare2, tmp, 'mine');
    await git.setUser(mine, { name: 'M', email: 'm@e.com', global: false });
    await git.run(['branch', '--unset-upstream'], { cwd: mine });      // SourceTree等で上流が無い状態
    assert.strictEqual((await git.status(mine)).upstream, null);
    // サーバーが先に進む
    W(seed, 's.txt', '2\n'); await git.stage(seed, ['s.txt']); await git.commit(seed, { summary: 's2' }); await git.run(['push', 'origin', 'HEAD:main'], { cwd: seed });
    W(mine, 'm.txt', 'x\n'); await git.stage(mine, ['m.txt']); await git.commit(mine, { summary: 'm1' });
    // 「最新を取り込む」が「先にアップロード」と言われて止まらない
    const r = await git.pull(mine);
    assert.strictEqual(r.conflict, false);
    assert.strictEqual((await git.status(mine)).upstream, 'origin/main');
    await git.push(mine);
    assert.strictEqual((await git.status(mine)).ahead, 0);
    // 上流なしで、先に進んだサーバーがあっても prepareSync で状況が分かる
    const m2 = path.join(tmp, 'mine2'); await git.clone(null, bare2, tmp, 'mine2');
    await git.run(['branch', '--unset-upstream'], { cwd: m2 });
    W(seed, 's.txt', '3\n'); await git.stage(seed, ['s.txt']); await git.commit(seed, { summary: 's3' }); await git.run(['pull', '--no-rebase', '--no-edit'], { cwd: seed }); await git.run(['push', 'origin', 'HEAD:main'], { cwd: seed });
    const st = await git.prepareSync(m2);
    assert.strictEqual(st.upstream, 'origin/main'); assert.ok(st.behind >= 1);
  });

  await t('サーバーに同名の分岐がない場合は、行き詰まらず案内する', async () => {
    const bare3 = path.join(tmp, 'empty.git'); await git.run(['init', '--bare', '-b', 'main', bare3], { cwd: tmp });
    const p3 = path.join(tmp, 'p3'); await git.init(p3); await git.setUser(p3, { name: 'M', email: 'm@e.com', global: false });
    W(p3, 'a.txt', '1\n'); await git.stage(p3, ['a.txt']); await git.commit(p3, { summary: 'a' });
    await git.addRemote(p3, 'origin', bare3);
    await assert.rejects(() => git.pull(p3), (e) => /まだこの作業の分岐がありません/.test(e.message));
    await git.push(p3);
    assert.strictEqual((await git.status(p3)).upstream, 'origin/main');
  });

  await t('名前・メールの自動設定: 未設定のときだけ入れ、既存の設定は上書きしない', async () => {
    const saved = process.env.GIT_CONFIG_GLOBAL;
    const g = path.join(tmp, 'auto.gitconfig'); fs.writeFileSync(g, '');
    process.env.GIT_CONFIG_GLOBAL = g;
    try {
      // 何もない → 両方入る（プロジェクトを開く前＝repo が null でも動く）
      let r = await git.setUserIfMissing(null, { name: '山田 太郎', email: '1+taro@users.noreply.github.com' });
      assert.deepStrictEqual(r.applied, { name: true, email: true });
      assert.strictEqual(r.name, '山田 太郎');
      // すでにある → 変えない
      r = await git.setUserIfMissing(null, { name: '別の人', email: 'other@example.com' });
      assert.deepStrictEqual(r.applied, { name: false, email: false });
      assert.strictEqual(r.name, '山田 太郎'); assert.strictEqual(r.email, '1+taro@users.noreply.github.com');
      // 片方だけ未設定 → 足りない方だけ入る
      await git.run(['config', '--global', '--unset', 'user.email'], { okCodes: [0, 5] });
      r = await git.setUserIfMissing(null, { name: '上書きしない', email: 'new@example.com' });
      assert.deepStrictEqual(r.applied, { name: false, email: true });
      assert.strictEqual(r.name, '山田 太郎'); assert.strictEqual(r.email, 'new@example.com');
      // 空の候補は何もしない
      fs.writeFileSync(g, '');
      r = await git.setUserIfMissing(null, { name: '  ', email: '' });
      assert.deepStrictEqual(r.applied, { name: false, email: false });
    } finally { process.env.GIT_CONFIG_GLOBAL = saved; }
  });

  await t('自動ひと言メモ: 変更したファイルから記録のメモの下書きを作る', async () => {
    const f = (p, x, y, o = {}) => ({ path: p, x, y, staged: x !== '.', unstaged: y !== '.', conflict: false, untracked: false, ...o });
    const M = U.suggestMemo;
    assert.strictEqual(M([]), '');
    assert.strictEqual(M([f('index.html', '.', 'M')]), 'index.html を変更');
    assert.strictEqual(M([f('index.html', '.', 'M'), f('css/style.css', '.', 'M')]), 'index.html と style.css を変更');
    assert.strictEqual(M([f('a', '.', 'M'), f('b', '.', 'M'), f('c', '.', 'M')]), 'a、b、c を変更');
    assert.strictEqual(M([f('a', '.', 'M'), f('b', '.', 'M'), f('c', '.', 'M'), f('d', '.', 'M'), f('e', '.', 'M')]), 'a、b ほか3個のファイルを変更');
    assert.strictEqual(M([f('logo.png', '.', '?', { untracked: true })]), 'logo.png を追加');
    assert.strictEqual(M([f('a.txt', '.', 'M'), f('b.css', '.', '?', { untracked: true })]), 'a.txt を変更、b.css を追加');
    assert.strictEqual(M([f('old.txt', '.', 'D')]), 'old.txt を削除');
    assert.strictEqual(M([f('new.txt', 'R', '.', { orig: 'old.txt' })]), 'old.txt → new.txt の名前を変更');
    // 「記録に含めるファイル」があれば、それだけが対象
    assert.strictEqual(M([f('x.txt', 'M', '.'), f('y.txt', '.', 'M')]), 'x.txt を変更');
    // ぶつかり中のファイルは含めない
    assert.strictEqual(M([f('c.txt', 'U', 'U', { conflict: true, staged: false, unstaged: false })]), '');
    // 同名ファイルはフォルダ付き
    assert.strictEqual(M([f('src/index.js', '.', 'M'), f('test/index.js', '.', 'M')]), 'src/index.js と test/index.js を変更');
    // 長すぎるときは件数でまとめる
    assert.strictEqual(M([f('ずっと長いファイル名その1.docx', '.', 'M'), f('ずっと長いファイル名その2.docx', '.', 'D'), f('ずっと長いファイル名その3.docx', '.', '?', { untracked: true })]), '3個のファイルを更新（変更1・追加1・削除1）');
    // 本物のGitの状態からも作れる
    const r = path.join(tmp, 'memo'); await git.init(r); await git.setUser(r, { name: 'M', email: 'm@e.com', global: false });
    W(r, 'keep.txt', '1\n'); W(r, 'gone.txt', '1\n'); W(r, 'edit.txt', '1\n');
    await git.stageAll(r); await git.commit(r, { summary: 'init' });
    W(r, 'edit.txt', '2\n'); W(r, 'brand-new.css', 'x\n'); fs.unlinkSync(path.join(r, 'gone.txt'));
    assert.strictEqual(M((await git.status(r)).files), 'edit.txt を変更、brand-new.css を追加、gone.txt を削除');
    await git.stage(r, ['brand-new.css']);
    assert.strictEqual(M((await git.status(r)).files), 'brand-new.css を追加');
  });

  await t('安全チェック（ルール）: ファイル名・大きさ・中身の判定', () => {
    // ファイル名
    for (const n of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'deploy/server.pem', 'my.key', 'credentials.json', 'service-account-prod.json', '.npmrc', 'terraform.tfstate']) assert.ok(safety.checkName(n), n + ' は検出される');
    for (const n of ['.env.example', '.env.sample', 'README.md', 'src/env.js', '.envrc', 'keyboard.js', 'monkey.txt', 'id_rsa.pub']) assert.strictEqual(safety.checkName(n), null, n + ' は検出しない');
    // 大きさ（GitHub: 100MB超は拒否、50MB超は警告）
    assert.strictEqual(safety.checkSize(10 * safety.MB), null);
    assert.strictEqual(safety.checkSize(50 * safety.MB), 'warn');
    assert.strictEqual(safety.checkSize(100 * safety.MB), 'block');
    // 中身
    assert.strictEqual(safety.checkLine('-----BEGIN RSA PRIVATE KEY-----').level, 'danger');
    assert.strictEqual(safety.checkLine('key = "AKIAIOSFODNN7EXAMPLE"').label, 'AWSのアクセスキー');
    assert.strictEqual(safety.checkLine('token: ghp_' + 'a'.repeat(36)).label, 'GitHubのトークン');
    assert.strictEqual(safety.checkLine('const k = "sk_live_' + 'A1b2C3d4E5f6G7h8' + '"').label, 'Stripeの本番キー');
    assert.strictEqual(safety.checkLine('password = "hunter2hunter2"').level, 'warn');
    assert.strictEqual(safety.checkLine('API_KEY: "abcd1234efgh5678"').level, 'warn');
    // よくある書き方（環境変数・snake_case・camelCase）
    for (const l of ['DB_PASSWORD = "realsecret123"', "MY_API_KEY='abcd1234efgh'", 'client_secret: "s3cr3t-value-1"', 'const dbPassword = "realsecret123";', 'STRIPE_SECRET_KEY="whsec_abcdef123456"', '"password": "realsecret123"']) assert.strictEqual((safety.checkLine(l) || {}).level, 'warn', l + ' は検出される');
    // 見間違いしやすいものは検出しない
    for (const l of ['passenger = "business-class"', 'const bypass = "something-long"', 'secretary = "Hanako-Yamada"', 'DB_PASSWORD = "${DB_PASSWORD}"', 'API_KEY = "<your-api-key>"', 'password = "xxxxxxxx"']) assert.strictEqual(safety.checkLine(l), null, l + ' は検出しない');
    assert.strictEqual(safety.checkLine('password = "your-password-here"'), null);
    assert.strictEqual(safety.checkLine('password = "${DB_PASSWORD}"'), null);
    assert.strictEqual(safety.checkLine('password = "abc"'), null);
    assert.strictEqual(safety.checkLine('const x = getPassword();'), null);
    assert.strictEqual(safety.checkLine('今日はいい天気です'), null);
    assert.strictEqual(safety.fmtSize(120 * safety.MB), '120 MB');
  });

  await t('安全チェック（Git連携）: これから送る記録だけを調べる', async () => {
    const bareS = path.join(tmp, 'safety.git'); await git.run(['init', '--bare', '-b', 'main', bareS], { cwd: tmp });
    const r = path.join(tmp, 'safe'); await git.init(r); await git.setUser(r, { name: 'M', email: 'm@e.com', global: false });
    await git.addRemote(r, 'origin', bareS);
    // 何もなければ空
    assert.deepStrictEqual(await git.safetyCheck(r), { commits: 0, findings: [], contentSkipped: false });
    // 問題のない記録
    W(r, 'readme.md', 'こんにちは\n'); W(r, '.env.example', 'API_KEY=\n'); W(r, 'src/app.js', 'const password = "your-password-here";\n');
    await git.stageAll(r); await git.commit(r, { summary: 'ok' });
    let c = await git.safetyCheck(r);
    assert.strictEqual(c.commits, 1); assert.deepStrictEqual(c.findings, []);
    // 送信済みの記録は調べない（過去に送ったものは対象外）
    W(r, '.env', 'SECRET=abc\n'); await git.stageAll(r); await git.commit(r, { summary: '.envを入れてしまった' });
    await git.stageAll(r);
    c = await git.safetyCheck(r);
    assert.ok(c.findings.some((f) => f.kind === 'file' && f.path === '.env' && f.level === 'danger'), '.env を検出');
    // 中身（行番号つき・秘密の値そのものは含まない）
    W(r, 'src/config.js', 'const a = 1;\nconst aws = "AKIAIOSFODNN7EXAMPLE";\nconst password = "realsecret123";\n');
    W(r, 'notes.txt', '++ これは行頭が+のメモ\n+++ これも\n');
    await git.stageAll(r); await git.commit(r, { summary: '設定' });
    c = await git.safetyCheck(r);
    const aws = c.findings.find((f) => f.label === 'AWSのアクセスキー');
    assert.ok(aws && aws.path === 'src/config.js' && aws.line === 2 && /^[0-9a-f]{7,}$/.test(aws.commit), 'AWSキーを行番号つきで検出: ' + JSON.stringify(aws));
    assert.ok(c.findings.some((f) => f.level === 'warn' && f.path === 'src/config.js' && f.line === 3), 'パスワードらしき記述を warn で検出');
    assert.ok(!c.findings.some((f) => f.path === 'notes.txt'), '行頭が + のメモを、ファイル名と誤認しない');
    assert.ok(!JSON.stringify(c).includes('AKIAIOSFODNN7EXAMPLE') && !JSON.stringify(c).includes('realsecret123'), '結果に秘密の値そのものを含めない');
    // 送ったあとは、もう調べる対象がない
    await git.push(r);
    c = await git.safetyCheck(r);
    assert.strictEqual(c.commits, 0); assert.deepStrictEqual(c.findings, []);
    // 大きなファイル（サイズの判定は検出ルールで確認済み。ここでは実ファイルで 50MB 超を検出）
    fs.writeFileSync(path.join(r, 'big.bin'), Buffer.alloc(51 * 1024 * 1024, 7));
    await git.stageAll(r); await git.commit(r, { summary: '大きいファイル' });
    c = await git.safetyCheck(r);
    const big = c.findings.find((f) => f.kind === 'size');
    assert.ok(big && big.level === 'warn' && big.path === 'big.bin' && big.size === 51 * 1024 * 1024, '50MB超を warn で検出');
    // 上流（アップロード先との結びつき）が無くても、サーバーに無い記録を調べる
    await git.run(['branch', '--unset-upstream'], { cwd: r });
    c = await git.safetyCheck(r);
    assert.strictEqual(c.commits, 1); assert.ok(c.findings.some((f) => f.kind === 'size'));
  });

  await t('URLからフォルダ名', () => {
    assert.strictEqual(git.repoNameFromUrl('https://github.com/a/b-c.git'), 'b-c');
    assert.strictEqual(git.repoNameFromUrl('git@github.com:a/b.git/'), 'b');
  });

  console.log(`\n${passed} 件成功${process.exitCode ? '（失敗あり）' : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
