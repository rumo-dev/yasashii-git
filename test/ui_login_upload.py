# ログイン必須の入り口 → ブラウザログイン → 「アップロード」だけでGitHubに自動作成・送信 → 一覧からダウンロード → ログアウトで入り口へ戻る
# 本物のGitHubには接続せず、test/fake_gh.sh（偽のgh）を使う。
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygup-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in")           # 無い = 未ログイン
repo = os.path.join(tmp, "メモ 帳"); os.makedirs(repo)  # 日本語・空白入りの名前でも名前が自動変換されること
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
open(os.path.join(repo, "a.txt"), "w").write("hello\n")

bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())
INIT = """
let cb = null;
window.api = { call: async (ns, fn, ...a) => { const r = await window.__call(ns, fn, JSON.stringify(a)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  ghLoginWeb: async () => { const t = setInterval(async () => { const r = await window.__call('app', 'pollCode', '[]'); if (r.value && cb) { cb(r.value); clearInterval(t); } }, 100);
    const r = await window.__call('gh', 'loginWeb', '[]'); clearInterval(t); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  onGhLoginCode(f) { cb = f; }, onMenu() {}, onProgress() {}, onUpdateState() {} };
"""
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))

        # 1. 未ログインでは入り口の画面だけ
        pg.wait_for_selector("button:has-text('GitHubにログインする')")
        check(pg.is_hidden("#sidebar") and pg.is_hidden("#topbar"), "未ログインだとサイドバー・上部バーは出ない（先へ進めない）")
        pg.keyboard.press("Escape")
        check(pg.is_visible("button:has-text('GitHubにログインする')"), "Escapeなどでも入り口は閉じない")
        pg.screenshot(path="/tmp/ygup_1_gate.png")

        # 2. ブラウザでログイン（コード表示 → 自動で先へ）
        pg.click("button:has-text('GitHubにログインする')")
        pg.wait_for_selector(".gate-code:has-text('ABCD-1234')")
        check(True, "確認コードが画面に表示される")
        pg.screenshot(path="/tmp/ygup_2_code.png")
        pg.wait_for_selector(".split.changes", timeout=15000)
        check(pg.is_visible("#sidebar"), "ログイン完了で自動的に本体の画面へ進む")

        # 3. 記録 → 「記録して、そのままアップロード」（接続先URLの登録なし）
        check("接続先" not in pg.inner_text("#topbar"), "上部バーにURL登録の要求がない")
        pg.click(".file-row:has-text('a.txt')")
        pg.fill("input[placeholder^='例：トップ']", "最初の記録")
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".modal:has-text('GitHub上の名前')")
        name = pg.input_value(".modal input[type=text]")
        check(name == "my-project", "日本語のフォルダ名はGitHubで使える名前に自動変換される: " + name)
        pg.fill(".modal input[type=text]", "memo-cho")
        pg.screenshot(path="/tmp/ygup_3_publish.png")
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check(True, "GitHubに作成して、そのままアップロードできた")
        log = sh("git", "--git-dir", os.path.join(remotes, "memo-cho.git"), "log", "main", "--format=%s")
        check("最初の記録" in log, "サーバー側に記録が届いている")
        check(sh("git", "rev-parse", "--abbrev-ref", "@{u}").strip() == "origin/main", "アップロード先の分岐が自動で結びついた")

        # 4. 2回目以降はそのままアップロードだけ（ダイアログなし）
        open(os.path.join(repo, "a.txt"), "a").write("more\n")
        pg.wait_for_selector(".file-row:has-text('a.txt')", timeout=8000)
        pg.fill("input[placeholder^='例：トップ']", "2回目")
        pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("2回目" in sh("git", "--git-dir", os.path.join(remotes, "memo-cho.git"), "log", "main", "--format=%s") and pg.locator(".modal").count() == 0, "2回目からは確認なしでアップロードできる")

        # 5. ダウンロードは一覧から選ぶ
        pg.click("#repoSwitch"); pg.click(".modal .btn:has-text('ダウンロード')")
        pg.wait_for_selector(".modal:has-text('tester/alpha')")
        check(pg.is_visible(".modal:has-text('team-org/shared')"), "自分のGitHubのプロジェクトが一覧に出る")
        pg.fill(".modal input[type=search]", "shared")
        check(pg.locator(".modal .row").count() == 1, "名前で絞り込める")
        pg.screenshot(path="/tmp/ygup_4_clone.png")
        pg.keyboard.press("Escape")

        # 5b. 他のツール（SourceTree等）で取得済みのフォルダ：originあり・SSH形式・上流の設定なし
        ext_bare = os.path.join(tmp, "ext.git"); sh("git", "init", "-q", "--bare", "-b", "main", ext_bare, cwd=tmp)
        ext = os.path.join(tmp, "from-sourcetree"); sh("git", "clone", "-q", ext_bare, ext, cwd=tmp)
        sh("git", "config", "user.name", "T", cwd=ext); sh("git", "config", "user.email", "t@e.com", cwd=ext)
        open(os.path.join(ext, "x.txt"), "w").write("x\n"); sh("git", "add", ".", cwd=ext); sh("git", "commit", "-qm", "既存", cwd=ext)
        sh("git", "remote", "set-url", "origin", "git@github.com:tester/ext.git", cwd=ext)
        call("app", "queuePick", ext)
        pg.click("#repoSwitch"); pg.click(".modal .btn:has-text('フォルダを開く')")
        try: pg.wait_for_selector(".modal:has-text('つなぎ方をそろえますか')", timeout=8000)
        except Exception:
            print("画面:", pg.inner_text("body")[:300]); raise
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('切り替えました')")
        check(sh("git", "remote", "get-url", "origin", cwd=ext).strip() == "https://github.com/tester/ext.git", "SSH形式の接続先をHTTPSに切り替えられる")
        check("URL" not in pg.inner_text("#hint") and "GitHubにありません" not in pg.inner_text("#hint"), "既存のoriginがあるフォルダは、登録なしでそのまま扱える")
        sh("git", "remote", "set-url", "origin", ext_bare, cwd=ext)   # テスト用にローカルのサーバーへ戻す
        pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
        pg.click("#topbar button:has-text('アップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("既存" in sh("git", "--git-dir", ext_bare, "log", "--all", "--format=%s", cwd=tmp), "上流が未設定でも、アップロードで自動的に結びつく")

        # 5c. 上流なし＋サーバーが先に進んでいる：「最新を取り込む」「アップロード」で行き詰まらない
        seed = os.path.join(tmp, "seed"); sh("git", "clone", "-q", ext_bare, seed, cwd=tmp)
        sh("git", "config", "user.name", "S", cwd=seed); sh("git", "config", "user.email", "s@e.com", cwd=seed)
        open(os.path.join(seed, "s.txt"), "w").write("s\n"); sh("git", "add", ".", cwd=seed); sh("git", "commit", "-qm", "サーバー側の更新", cwd=seed); sh("git", "push", "-q", "origin", "HEAD:main", cwd=seed)
        sh("git", "branch", "--unset-upstream", cwd=ext)
        pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
        pg.click("#topbar button:has-text('最新を取り込む')")
        pg.wait_for_selector(".toast:has-text('最新を取り込みました')", timeout=20000)
        check(os.path.exists(os.path.join(ext, "s.txt")), "上流が無くても「最新を取り込む」で取り込める（「先にアップロード」で止まらない）")
        sh("git", "branch", "--unset-upstream", cwd=ext)
        open(os.path.join(seed, "s.txt"), "a").write("more\n"); sh("git", "commit", "-qam", "さらに更新", cwd=seed); sh("git", "push", "-q", "origin", "HEAD:main", cwd=seed)
        open(os.path.join(ext, "y.txt"), "w").write("y\n"); sh("git", "add", ".", cwd=ext); sh("git", "commit", "-qm", "手元の更新", cwd=ext)
        pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
        pg.click("#topbar button:has-text('アップロード')")
        pg.wait_for_selector(".toast:has-text('取り込んでから、アップロードしました')", timeout=25000)
        lg = sh("git", "--git-dir", ext_bare, "log", "--all", "--format=%s", cwd=tmp)
        check("手元の更新" in lg and "さらに更新" in lg, "サーバーが先に進んでいても、「アップロード」だけで取り込み→送信まで自動で行う")

        # 6. ログアウトすると入り口へ戻る
        pg.click(".nav-item[data-id=github]"); pg.click("button:has-text('ログアウト')"); pg.click(".modal .btn.danger.solid")
        pg.wait_for_selector("button:has-text('GitHubにログインする')", timeout=15000)
        check(pg.is_hidden("#sidebar") and not os.path.exists(state), "ログアウトすると、また入り口の画面に戻る")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    try: pg.screenshot(path="/tmp/ygup_fail.png"); print("画面:", pg.inner_text("body")[:600])
    except Exception: pass
    errors.append("例外")
finally:
    bridge.terminate()
print("\n結果:", "失敗 %d 件" % len(errors) if errors else "すべて成功")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
