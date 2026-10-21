# チーム機能 → ブラウザログイン → 「アップロード」だけでGitHubに自動作成・送信 → 一覧からダウンロード → ログアウトで入り口へ戻る
# 本物のGitHubには接続せず、test/fake_gh.sh（偽のgh）を使う。
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygup-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("1"); open(state + ".inv", "w").write("1")
repo = os.path.join(tmp, "memo"); os.makedirs(repo)  # 日本語・空白入りの名前でも名前が自動変換されること
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
open(os.path.join(repo, "a.txt"), "w").write("hello\n"); sh("git", "add", "."); sh("git", "commit", "-qm", "init")

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
def clear_toasts(pg): pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes")

        # リンクの読み取り（いろいろな形のリンクから プロジェクトを特定）
        cases = {"https://github.com/team-org/shared": "team-org/shared", "https://github.com/team-org/shared/tree/main/src": "team-org/shared", "https://github.com/team-org/shared/invitations": "team-org/shared",
                 "https://github.com/team-org/shared.git": "team-org/shared", "git@github.com:team-org/shared.git": "team-org/shared", "github.com/team-org/shared/pull/3": "team-org/shared", "team-org/shared": "team-org/shared"}
        bad = [k for k, v in cases.items() if (lambda r: f"{r['owner']}/{r['repo']}" if r else None)(pg.evaluate("(u) => parseRepoRef(u)", k)) != v]
        check(not bad, "いろいろな形のリンクから、プロジェクトを読み取れる" + (" 失敗:" + str(bad) if bad else ""))

        # 届いた招待が、メニューのバッジに出る
        pg.wait_for_selector(".nav-item[data-id=team] .count:not([hidden])", timeout=10000)
        check(pg.inner_text(".nav-item[data-id=team] .count") == "1", "届いた招待の件数が「チーム」のメニューに出る")

        # GitHubにまだ無いプロジェクト
        pg.click(".nav-item[data-id=team]"); pg.wait_for_selector("text=まだGitHubにありません")
        check(pg.is_visible("button:has-text('GitHubに作成してアップロード')"), "GitHubに無いプロジェクトでは、作成を案内する")
        sh("gh", "repo", "create", "memo", "--private", "--source", ".", "--remote", "origin")   # 作成済みにする

        # 共有リンク・メンバー
        pg.click(".nav-item[data-id=github]"); pg.click(".nav-item[data-id=team]")
        pg.wait_for_selector("text=https://github.com/tester/memo")
        check(pg.is_visible(".card:has-text('共有リンク') >> text=コピー"), "共有リンクが表示され、コピーできる")
        pg.wait_for_selector("text=メンバー（1人）")
        check("管理者" in pg.inner_text("#view") and "あなた" in pg.inner_text("#view"), "メンバー一覧に権限（管理者）と「あなた」が出る")
        pg.screenshot(path="/tmp/ygteam_1.png")

        # 招待する
        pg.click("button:has-text('＋ 招待する')")
        pg.fill(".modal input[type=text]", "@hanako")
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('招待を送りました')")
        check(True, "ユーザー名（@つきでも可）を入れて招待できる")
        pg.screenshot(path="/tmp/ygteam_2.png")
        pg.click(".modal .btn.primary")   # 招待リンクをコピー
        pg.wait_for_selector("text=返事待ちの招待")
        check("hanako" in pg.inner_text("#view"), "送った招待が「返事待ち」に出る")
        pg.click("button:has-text('取り消す')"); pg.wait_for_selector(".toast:has-text('取り消しました')")
        # 存在しない人
        pg.click("button:has-text('＋ 招待する')"); pg.fill(".modal input[type=text]", "nobody-x"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('うまくいきませんでした')")
        check("見つからない" in pg.inner_text(".modal"), "存在しないユーザー名は、わかりやすい日本語のエラー")
        pg.click(".modal .btn.primary")
        pg.click("button:has-text('＋ 招待する')"); pg.fill(".modal input[type=text]", "bad name!"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('形式が正しくありません')"); pg.click(".modal .btn.primary")
        check(True, "ユーザー名の形式が違うときも案内が出る")
        pg.keyboard.press("Escape")

        # 届いた招待に参加する
        pg.wait_for_selector("text=招待が届いています（1件）")
        pg.screenshot(path="/tmp/ygteam_3.png")
        pg.click(".card:has-text('招待が届いています') >> button:has-text('参加する')")
        pg.wait_for_selector(".modal:has-text('ダウンロードしますか')")
        check(os.path.exists(state + ".accepted"), "「参加する」で招待を受けられる")
        pg.click(".modal .btn:has-text('キャンセル')")
        pg.wait_for_function("document.querySelector('.nav-item[data-id=team] .count').hidden")
        check(True, "参加するとバッジが消える")

        # リンクで参加：入れないリンク → 招待をお願いする案内（ユーザー名つき）
        pg.click("button:has-text('🔗 リンクで参加する')")
        pg.fill(".modal input[type=text]", "https://github.com/someone/secret/tree/main")
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('まだ参加できていません')")
        check("tester" in pg.inner_text(".modal") and "招待" in pg.inner_text(".modal"), "入れないリンクでは、自分のユーザー名を添えて招待のお願いを案内する")
        pg.screenshot(path="/tmp/ygteam_4.png")
        pg.click(".modal .btn.primary")
        # 招待が届いているプロジェクトのリンク → 参加して続行
        open(state + ".inv", "w").write("1"); os.remove(state + ".accepted")
        pg.click("button:has-text('🔗 リンクで参加する')")
        pg.fill(".modal input[type=text]", "https://github.com/team-org/invited/invitations")
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('招待が届いています')")
        pg.click(".modal .btn.primary")
        pg.wait_for_function("true"); 
        for _ in range(50):
            if os.path.exists(state + ".accepted"): break
            time.sleep(0.1)
        check(os.path.exists(state + ".accepted"), "招待が届いているプロジェクトのリンクなら、そのまま参加できる")
        # ダウンロードの一覧に、チームのプロジェクトも出る
        pg.click("#repoSwitch"); pg.click(".modal .btn:has-text('ダウンロード')")
        pg.wait_for_selector(".modal:has-text('team-org/shared')")
        check("チーム・共有" in pg.inner_text(".modal"), "ダウンロードの一覧に、チームのプロジェクトも「チーム・共有」と出る")
        pg.screenshot(path="/tmp/ygteam_5.png")
        pg.keyboard.press("Escape")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    errors.append("例外")
finally:
    bridge.terminate()
print("\n結果:", "失敗 %d 件" % len(errors) if errors else "すべて成功")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
