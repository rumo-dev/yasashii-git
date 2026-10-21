# 新機能の画面テスト：
#   1) アプリの自動更新のお知らせ（見つかった → ダウンロード中 → 準備できた → 再起動）／手動更新の環境／「あとで」／設定画面／メニューからの確認
#   2) ログイン切れ・SSH鍵エラーの自動復旧（その場で再ログインへ案内 → 終わったら操作を自動でやり直す）
# 本物のGitHubには接続しない（test/fake_gh.sh の偽gh、ローカルの bare リポジトリを使う）。更新の状態は画面へ直接送って再現する。
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygua-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in")
open(state, "w").write("")                                   # 最初はログイン済み
repo = os.path.join(tmp, "proj"); os.makedirs(repo)
bare = os.path.join(remotes, "proj.git")
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
sh("git", "init", "-q", "--bare", "-b", "main", bare, cwd=tmp)
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
sh("git", "remote", "add", "origin", bare)
open(os.path.join(repo, "a.txt"), "w").write("hello\n"); sh("git", "add", "."); sh("git", "commit", "-qm", "最初"); sh("git", "push", "-q", "-u", "origin", "main")

bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())

# 画面からの呼び出しを横取りして、失敗や更新の状態を作る
calls = []          # [(ns, fn)]
inject = {}         # "git.push" -> [エラー情報, ...]（先頭から1回ずつ使う）
override = {}       # "app.downloadUpdate" -> 戻り値
def handler(ns, fn, a):
    key = f"{ns}.{fn}"; calls.append(key)
    if inject.get(key):
        e = inject[key].pop(0)
        if e.get("expire") and os.path.exists(state): os.remove(state)   # トークンが取り消された状態を再現
        return {"ok": False, "error": {"message": e["message"], "detail": e["detail"], "kind": e["kind"]}}
    if key in override: return {"ok": True, "value": override[key]}
    return call(ns, fn, *json.loads(a))

INIT = """
let cb = null;
window.api = { call: async (ns, fn, ...a) => { const r = await window.__call(ns, fn, JSON.stringify(a)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; e.kind = r.error.kind || ''; throw e; },
  ghLoginWeb: async () => { const t = setInterval(async () => { const r = await window.__call('app', 'pollCode', '[]'); if (r.value && cb) { cb(r.value); clearInterval(t); } }, 100);
    const r = await window.__call('gh', 'loginWeb', '[]'); clearInterval(t); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  onGhLoginCode(f) { cb = f; }, onMenu(f) { window.__menu = f; }, onProgress() {}, onUpdateState(f) { window.__upd = f; } };
"""
AUTH_ERR = {"message": "GitHubのログインが切れているか、認証に失敗しました。ログインし直してから、もう一度お試しください。", "detail": "fatal: Authentication failed for 'https://github.com/tester/proj.git/'", "kind": "auth"}
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
def clear_toasts(pg): pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
def new_commit(pg, text, memo):
    open(os.path.join(repo, "a.txt"), "a").write(text + "\n")
    pg.wait_for_selector(".file-row:has-text('a.txt')", timeout=9000)
    pg.fill("input[placeholder^='例：トップ']", memo)
def server_log(): return sh("git", "--git-dir", bare, "log", "main", "--format=%s")
DLG = ".overlay .modal"
def upd(pg, **kw):
    s = {"status": "idle", "mode": "auto", "reason": "", "currentVersion": "0.1.0", "version": "", "notes": "", "percent": 0, "error": "", "manual": False, "checkedAt": 0, "releaseUrl": ""}
    s.update(kw); pg.evaluate("(s) => window.__upd(s)", s)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: handler(ns, fn, a))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes", timeout=15000)

        print("【自動更新のお知らせ】")
        check(pg.is_hidden("#updateBanner"), "新しい版がないときは、帯は出ない")
        upd(pg, status="available", version="0.2.0", notes="・新しい機能を追加しました\n・不具合を直しました")
        pg.wait_for_selector("#updateBanner:not([hidden])")
        t = pg.inner_text("#updateBanner")
        check("v0.2.0" in t and "v0.1.0" in t, "新しい版と、いまの版が帯に出る: " + t.replace("\n", " "))
        check(pg.is_visible("#updateBanner button:has-text('更新する')"), "自動で入れ替えられる環境では「更新する」が出る")
        pg.screenshot(path="/tmp/ygua_1_available.png")
        pg.click("#updateBanner button:has-text('更新内容を見る')")
        pg.wait_for_selector(f"{DLG}:has-text('新しい機能を追加しました')")
        check(True, "「更新内容を見る」で説明が読める")
        pg.keyboard.press("Escape")

        # 「あとで」で閉じる → 左下のリンクから戻せる
        pg.click("#updateBanner button:has-text('あとで')")
        check(pg.is_hidden("#updateBanner") and pg.is_visible("#updateLink"), "「あとで」で帯が閉じ、左のメニューの下にリンクが残る")
        pg.click("#updateLink")
        check(pg.is_visible("#updateBanner"), "リンクを押すと、帯がまた出る")

        # 更新する → ダウンロード中 → 準備できた → 再起動
        override["app.downloadUpdate"] = {"status": "downloading", "mode": "auto", "currentVersion": "0.1.0", "version": "0.2.0", "notes": "", "percent": 0, "error": ""}
        pg.click("#updateBanner button:has-text('更新する')")
        pg.wait_for_selector("#updateBanner:has-text('ダウンロード中')")
        upd(pg, status="downloading", version="0.2.0", percent=42)
        pg.wait_for_selector("#updateBanner:has-text('42%')")
        w = pg.evaluate("document.querySelector('#updateBanner .bar > div').style.width")
        check("app.downloadUpdate" in calls and w == "42%", "ダウンロードを始め、進み具合（42%）が出る")
        pg.click(".nav-item:has-text('変更')")
        check(pg.is_visible("#updateBanner"), "ダウンロード中は、他の画面に移っても帯が残る")
        upd(pg, status="downloaded", version="0.2.0", percent=100)
        pg.wait_for_selector("#updateBanner button:has-text('再起動して更新')")
        check("準備ができました" in pg.inner_text("#updateBanner"), "準備ができたら「再起動して更新」が出る")
        pg.click("#updateBanner button:has-text('再起動して更新')")
        pg.wait_for_selector(f"{DLG}:has-text('再起動して更新しますか')")
        pg.click(f"{DLG} button:has-text('キャンセル')")
        check("app.installUpdate" not in calls, "確認で「キャンセル」なら、再起動しない")
        pg.click("#updateBanner button:has-text('再起動して更新')"); pg.click(f"{DLG} .btn.primary")
        pg.wait_for_function("true");
        check(any(c == "app.installUpdate" for c in calls), "確認で「再起動して更新」を押すと、入れ替えを依頼する")
        upd(pg)

        # 手動更新の環境（署名なしMac・ポータブル版など）
        upd(pg, status="available", mode="manual", version="0.3.0", releaseUrl="https://github.com/o/r/releases/latest")
        pg.wait_for_selector("#updateBanner button:has-text('ダウンロードページを開く')")
        override["app.downloadUpdate"] = {"status": "available", "mode": "manual", "currentVersion": "0.1.0", "version": "0.3.0", "notes": "", "percent": 0, "error": ""}
        clear_toasts(pg); pg.click("#updateBanner button:has-text('ダウンロードページを開く')")
        pg.wait_for_selector(".toast:has-text('ダウンロードページ')")
        check(True, "自動で入れ替えられない環境では、ダウンロードページを開く案内になる")
        upd(pg)

        # メニュー「新しい版を確認…」と、設定画面
        override["app.checkForUpdates"] = {"status": "uptodate", "mode": "auto", "currentVersion": "0.1.0", "version": "", "notes": "", "percent": 0, "error": ""}
        clear_toasts(pg); pg.evaluate("window.__menu('update')")
        pg.wait_for_selector(".toast:has-text('最新の版です')")
        check(True, "メニューの「新しい版を確認」で、最新なら「最新の版です」と出る")
        override["app.checkForUpdates"] = {"status": "idle", "mode": "auto", "currentVersion": "0.1.0", "version": "", "notes": "", "percent": 0, "error": "ネットワークにつながりませんでした。インターネット接続を確認してください。"}
        clear_toasts(pg); pg.evaluate("window.__menu('update')")
        pg.wait_for_selector(".toast.error:has-text('ネットワーク')")
        check(True, "確認に失敗したら、理由がやさしい日本語で出る")
        pg.click(".nav-item:has-text('設定')")
        pg.wait_for_selector(".card:has-text('アプリの更新')")
        check(pg.is_visible(".card:has-text('アプリの更新') button:has-text('新しい版を確認')"), "設定画面に更新のカードがある")
        check("v0.1.0" in pg.inner_text(".pad"), "設定画面の版の表示が、実際の版になっている")
        upd(pg, status="available", version="0.4.0", notes="x")
        pg.wait_for_selector(".card:has-text('アプリの更新'):has-text('v0.4.0')")
        check(pg.is_visible(".card:has-text('アプリの更新') button:has-text('更新する')"), "設定画面も、状態の変化にあわせて自動で変わる")
        pg.screenshot(path="/tmp/ygua_2_settings.png")
        upd(pg); override.clear()
        pg.click(".nav-item:has-text('変更')")

        print("【ログイン切れの自動復旧】")
        # A. トークンが取り消された → その場で再ログイン → 同じ操作を自動でやり直す
        new_commit(pg, "A", "A: ログイン切れ")
        inject["git.push"] = [dict(AUTH_ERR, expire=True)]
        calls.clear(); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('ログインし直してください')", timeout=15000)
        check(pg.is_hidden("#busy"), "案内が出る間は、処理中の表示が外れている（操作をじゃましない）")
        check(pg.locator(f"{DLG}:has-text('うまくいきませんでした')").count() == 0, "「うまくいきませんでした」ではなく、再ログインの案内が出る")
        pg.screenshot(path="/tmp/ygua_3_relogin.png")
        pg.click(f"{DLG} button:has-text('ログインし直す')")
        pg.wait_for_selector("button:has-text('GitHubにログインする')")
        check("さっきの操作" in pg.inner_text(".gate"), "再ログインの画面に、操作を続けられる旨が出る")
        pg.click("button:has-text('GitHubにログインする')")
        pg.wait_for_selector(".gate-code:has-text('ABCD-1234')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=30000)
        check("A: ログイン切れ" in server_log(), "再ログイン後、アップロードが自動でやり直されて成功した")
        check(calls.count("git.push") == 2, "アップロードの試行は、失敗1回＋やり直し1回だけ")
        check(pg.is_visible("#sidebar") and pg.is_visible(".split.changes"), "元の「変更」画面に戻っている")

        # B. 「あとで」を選ぶ → エラーの箱は重ねず、何も送らない
        new_commit(pg, "B", "B: あとで")
        inject["git.push"] = [dict(AUTH_ERR, expire=True)]
        clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('ログインし直してください')", timeout=15000)
        pg.click(f"{DLG} button:has-text('あとで')")
        pg.wait_for_selector(".toast:has-text('あとでログインし直してください')")
        pg.wait_for_function("document.querySelectorAll('.overlay').length === 0")
        check("B: あとで" not in server_log(), "「あとで」なら、アップロードされない")
        check(pg.locator(f"{DLG}").count() == 0, "「あとで」のあとに、エラーの箱は重ならない")
        open(state, "w").write("")   # ログイン済みに戻す
        pg.evaluate("S.auth = { installed: true, loggedIn: true }")
        clear_toasts(pg)
        pg.click("#topbar button:has-text('アップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("B: あとで" in server_log(), "ログインが有効なら、あとから普通にアップロードできる")

        # C. ログインは有効なのに認証が通らない → 静かにログイン情報を設定し直して再試行（案内は出さない）
        new_commit(pg, "C", "C: 設定し直し")
        inject["git.push"] = [AUTH_ERR]
        calls.clear(); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("C: 設定し直し" in server_log() and "gh.refreshGitCredentials" in calls, "ログインが有効なら、案内なしで設定し直して成功する")

        # D. 設定し直しても通らない → 再ログインの案内（ログインは有効でも入れ直せる）
        new_commit(pg, "D", "D: 入れ直し")
        inject["git.push"] = [AUTH_ERR]   # 直前（C）に設定し直したばかりなので、同じ手は繰り返さず、再ログインを案内する
        clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('ログインし直してください')", timeout=20000)
        check("認証が通りませんでした" in pg.inner_text(DLG), "続けて失敗したら、再ログインを案内する（文面は「認証が通りませんでした」）")
        pg.click(f"{DLG} button:has-text('ログインし直す')")
        pg.wait_for_selector("button:has-text('GitHubにログインする')")   # 有効なログインも、いったん外して入れ直せる
        pg.click("button:has-text('GitHubにログインする')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=30000)
        check("D: 入れ直し" in server_log(), "入れ直したあと、アップロードが完了した")

        # E. 再ログインしても同じ認証エラー → 案内をくり返さず、通常のエラーを出す
        new_commit(pg, "E", "E: 失敗のまま")
        pg.evaluate("S.auth = { installed: true, loggedIn: true }")
        inject["git.push"] = [dict(AUTH_ERR, expire=True), AUTH_ERR]
        clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('ログインし直してください')", timeout=20000)
        pg.click(f"{DLG} button:has-text('ログインし直す')")
        pg.wait_for_selector("button:has-text('GitHubにログインする')"); pg.click("button:has-text('GitHubにログインする')")
        pg.wait_for_selector(f"{DLG}:has-text('うまくいきませんでした')", timeout=30000)
        check(pg.locator(f"{DLG}:has-text('ログインし直してください')").count() == 0, "やり直しでも失敗したら、案内をくり返さず通常のエラーを出す")
        pg.click(f"{DLG} button:has-text('閉じる')")

        print("【権限（workflow）が足りない】")
        new_commit(pg, "F", "F: 権限不足")
        pg.evaluate("S.auth = { installed: true, loggedIn: true }")
        inject["git.push"] = [{"message": "GitHubのログインに「ワークフロー…」の権限が足りないため、拒否されました。", "detail": "! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/release.yml` without `workflow` scope)", "kind": "scope"}]
        clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('ログインの権限が足りません')", timeout=20000)
        check("最新を取り込む" not in pg.inner_text(DLG), "「最新を取り込んで」ではなく、権限不足として案内される")
        pg.screenshot(path="/tmp/ygua_5_scope.png")
        pg.click(f"{DLG} button:has-text('ログインし直す')")
        pg.wait_for_selector("button:has-text('GitHubにログインする')"); pg.click("button:has-text('GitHubにログインする')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=30000)
        check("F: 権限不足" in server_log(), "ログインし直したあと、アップロードが自動でやり直されて成功した")
        check("--scopes repo,read:org,workflow" in open(state + ".loginargs").read(), "ブラウザログインは、workflow の権限つきで行われる")

        print("【SSH鍵エラーの自動復旧】")
        sh("git", "remote", "set-url", "origin", "git@github.com:tester/proj.git")
        pg.evaluate("S.settings.sshAsked = [S.repo]")
        override["git.push"] = True; override["git.prepareSync"] = {"hasCommits": True, "behind": 0}   # 本物のSSH接続は試さない
        inject["git.push"] = [{"message": "SSH鍵でGitHubにつながりませんでした。", "detail": "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "kind": "ssh"}]
        calls.clear(); clear_toasts(pg)
        pg.click("#topbar button:has-text('アップロード')")
        try: pg.wait_for_selector(f"{DLG}:has-text('SSH鍵で接続できませんでした')", timeout=20000)
        except Exception:
            print("画面:", pg.inner_text("body")[:400]); raise
        check("git@github.com:tester/proj.git" in pg.inner_text(DLG) and "https://github.com/tester/proj.git" in pg.inner_text(DLG), "SSH → HTTPS の切り替え内容が見える")
        pg.screenshot(path="/tmp/ygua_4_ssh.png")
        pg.click(f"{DLG} button:has-text('HTTPS形式に切り替えて続ける')")
        pg.wait_for_selector(".toast:has-text('HTTPS形式に切り替えました')")
        check(sh("git", "remote", "get-url", "origin").strip() == "https://github.com/tester/proj.git", "接続先がHTTPS形式に切り替わった")
        check(calls.count("git.push") == 2, "切り替えのあと、アップロードが自動でやり直された")
        sh("git", "remote", "set-url", "origin", bare)
        override.clear()

        print("【操作していない間の見張り】")
        os.remove(state)
        pg.evaluate("void authWatchTick()")
        pg.wait_for_selector(f"{DLG}:has-text('ログインし直してください')", timeout=15000)
        check(True, "操作していなくても、ログインが切れていたら案内が出る")
        pg.click(f"{DLG} button:has-text('あとで')")
        pg.wait_for_function("document.querySelectorAll('.overlay').length === 0")
        pg.evaluate("void authWatchTick()"); pg.wait_for_timeout(1200)
        check(pg.locator(".overlay").count() == 0, "「あとで」のあとは、しばらく案内をくり返さない")
        open(state, "w").write("")

        print("【ログイン画面のエラーは対象外】")
        pg.evaluate("S.auth = null")
        r = pg.evaluate("recoverAuth({ kind: 'auth' })")
        check(r == "not-auth", "ログイン画面の最中は、再ログインの案内を重ねない")

finally:
    bridge.kill()
print("\n結果:", "すべて成功" if not errors else f"失敗 {len(errors)} 件")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
