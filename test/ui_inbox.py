# 受信箱（招待・変更の提案・課題の通知）／まとめて更新ボタン／左メニューの分岐一覧／右クリックからの「管理しない一覧に追加」
# 本物のGitHubには接続しない（test/fake_gh.sh の偽gh）。
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygib-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("")
repo = os.path.join(tmp, "proj"); os.makedirs(repo)
bare = os.path.join(remotes, "proj.git")
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
sh("git", "init", "-q", "--bare", "-b", "main", bare, cwd=tmp)
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
sh("git", "remote", "add", "origin", bare)
open(os.path.join(repo, "a.txt"), "w").write("hello\n"); sh("git", "add", "."); sh("git", "commit", "-qm", "最初"); sh("git", "push", "-q", "-u", "origin", "main")
sh("git", "branch", "feature-x"); sh("git", "push", "-q", "origin", "feature-x")
# 別の人が先に進めた状態を作る
other = os.path.join(tmp, "other"); sh("git", "clone", "-q", bare, other, cwd=tmp)
sh("git", "config", "user.name", "O", cwd=other); sh("git", "config", "user.email", "o@e.com", cwd=other)
open(os.path.join(other, "o.txt"), "w").write("o\n"); sh("git", "add", ".", cwd=other); sh("git", "commit", "-qm", "相手の更新", cwd=other); sh("git", "push", "-q", "origin", "main", cwd=other)
# 招待と通知
open(state + ".inv", "w").write("")
NOTES = [
  {"id": "101", "unread": True, "reason": "review_requested", "title": "ログイン画面を追加", "type": "PullRequest", "apiUrl": "https://api.github.com/repos/team-org/shared/pulls/12", "repo": "team-org/shared", "updatedAt": "2026-10-20T00:00:00Z"},
  {"id": "102", "unread": True, "reason": "mention", "title": "ボタンの色が変", "type": "Issue", "apiUrl": "https://api.github.com/repos/team-org/shared/issues/7", "repo": "team-org/shared", "updatedAt": "2026-10-20T01:00:00Z"},
  {"id": "103", "unread": True, "reason": "ci_activity", "title": "build failed", "type": "CheckSuite", "apiUrl": "https://api.github.com/repos/team-org/shared/check-suites/9", "repo": "team-org/shared", "updatedAt": "2026-10-20T02:00:00Z"},
]
open(state + ".notes", "w").write("\n".join(json.dumps(n, ensure_ascii=False) for n in NOTES) + "\n")

bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())
opened = []
def handler(ns, fn, a):
    if ns == "app" and fn == "openExternal": opened.append(json.loads(a)[0]); return {"ok": True, "value": True}
    return call(ns, fn, *json.loads(a))
INIT = """
window.api = { call: async (ns, fn, ...a) => { const r = await window.__call(ns, fn, JSON.stringify(a)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; e.kind = r.error.kind || ''; throw e; },
  ghLoginWeb: async () => ({}), onGhLoginCode() {}, onMenu(f) { window.__menu = f; }, onProgress() {}, onUpdateState() {} };
"""
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
def clear_toasts(pg): pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 850})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: handler(ns, fn, a))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes", timeout=15000)

        print("【左メニューの分岐一覧】")
        pg.wait_for_selector(".side-row[data-branch='main']")
        check(pg.is_visible(".side-row[data-branch='feature-x']"), "手元の分岐が、左のメニューに出る（最初から開いている）")
        check(pg.locator(".side-row[data-branch='origin/feature-x']").is_hidden(), "サーバー上の分岐は、最初は折りたたまれている")
        check("current" in (pg.get_attribute(".side-row[data-branch='main']", "class") or ""), "いまの分岐が目立つ")
        pg.click(".side-head:has-text('サーバー上の分岐')")
        check(pg.is_visible(".side-row[data-branch='origin/feature-x']"), "クリックで、サーバー上の分岐が開く")
        pg.click(".side-head:has-text('手元の分岐')")
        check(pg.locator(".side-row[data-branch='feature-x']").is_hidden(), "手元の分岐も、折りたたみできる")
        pg.click(".side-head:has-text('手元の分岐')")
        pg.click(".side-row[data-branch='feature-x']")
        pg.wait_for_selector(".toast:has-text('feature-x')")
        check(sh("git", "branch", "--show-current").strip() == "feature-x", "手元の分岐をクリックすると、切り替わる")
        pg.wait_for_selector(".side-row.current[data-branch='feature-x']")
        pg.click(".side-row[data-branch='main']"); pg.wait_for_selector(".side-row.current[data-branch='main']")

        print("【受信箱】")
        pg.wait_for_selector(".nav-item[data-id=inbox] .count:not([hidden])")
        check(pg.inner_text(".nav-item[data-id=inbox] .count") == "4", "受信箱の印に、招待1＋お知らせ3＝4件が出る: " + pg.inner_text(".nav-item[data-id=inbox] .count"))
        pg.click(".nav-item[data-id=inbox]")
        pg.wait_for_selector(".row:has-text('ログイン画面を追加')")
        check(pg.is_visible(".card:has-text('招待（1件）'):has-text('team-org/invited')"), "招待が、受信箱に出る")
        check(pg.is_visible(".row:has-text('ログイン画面を追加'):has-text('レビューの依頼')") and pg.is_visible(".row:has-text('ボタンの色が変'):has-text('メンション')"), "変更の提案・課題のお知らせが、理由つきで出る")
        pg.screenshot(path="/tmp/ygib_1_inbox.png")
        pg.click("button:has-text('変更の提案（1）')")
        check(pg.locator(".row[data-note]").count() == 1 and pg.is_visible(".row:has-text('ログイン画面を追加')"), "「変更の提案」で絞り込める")
        pg.click("button:has-text('すべて（3）')")
        pg.click(".row:has-text('ログイン画面を追加') button:has-text('ブラウザで開く')")
        pg.wait_for_function("true")
        check(opened and opened[-1] == "https://github.com/team-org/shared/pull/12", "「ブラウザで開く」で、該当ページ（#12）を開く: " + str(opened[-1:]))
        pg.click(".row:has-text('ボタンの色が変') button:has-text('既読にする')")
        pg.wait_for_selector(".row:has-text('ボタンの色が変')", state="detached")
        check(pg.inner_text(".nav-item[data-id=inbox] .count") == "3", "既読にすると、件数が減る")
        # 手動確認：新しいお知らせが増えたあと、「いま確認する」で拾える
        with open(state + ".notes", "a") as f: f.write(json.dumps({"id": "104", "unread": True, "reason": "assign", "title": "READMEを直す", "type": "Issue", "apiUrl": "https://api.github.com/repos/team-org/shared/issues/9", "repo": "team-org/shared", "updatedAt": "2026-10-20T03:00:00Z"}, ensure_ascii=False) + "\n")
        pg.click("#inboxCheck")
        pg.wait_for_selector(".row:has-text('READMEを直す')")
        check(True, "「いま確認する」で、新しいお知らせを手動で確認できる")
        pg.click("button:has-text('すべて既読にする')")
        pg.wait_for_selector("text=新しいお知らせはありません")
        check(True, "「すべて既読にする」で空になる")
        pg.click(".row:has-text('team-org/invited') button:has-text('参加する')")
        pg.wait_for_selector(f".overlay .modal:has-text('ダウンロードしますか')"); pg.keyboard.press("Escape")
        pg.wait_for_selector("text=届いている招待はありません")
        check(pg.locator(".nav-item[data-id=inbox] .count:not([hidden])").count() == 0, "招待に参加すると、受信箱の印が消える")
        pg.click(".nav-item[data-id=changes]")

        print("【まとめて更新】")
        open(state + ".inv", "w").write("")
        with open(state + ".notes", "w") as f: f.write(json.dumps(NOTES[0], ensure_ascii=False) + "\n")
        check(pg.is_visible("#syncAllBtn"), "上部バーに「まとめて更新」がある")
        before = sh("git", "rev-parse", "HEAD").strip()
        clear_toasts(pg); pg.click("#syncAllBtn")
        pg.wait_for_selector(".toast:has-text('最新を取り込みました')", timeout=30000)
        check(sh("git", "rev-parse", "HEAD").strip() != before and os.path.exists(os.path.join(repo, "o.txt")), "サーバーの新しい更新が、1ボタンで取り込まれる")
        check("受信箱に 2 件" in pg.inner_text("#toasts"), "同時に受信箱も確認される（招待1＋お知らせ1）: " + pg.inner_text("#toasts").replace("\n", " "))
        pg.wait_for_function("document.querySelector('.nav-item[data-id=inbox] .count').textContent === '2'")
        clear_toasts(pg); pg.click("#syncAllBtn")
        pg.wait_for_selector(".toast:has-text('プロジェクトは最新です')", timeout=30000)
        check(True, "更新がないときは「最新です」と伝える")

        print("【右クリックから「管理しない一覧に追加」】")
        open(os.path.join(repo, "debug.log"), "w").write("x\n"); os.makedirs(os.path.join(repo, "tmpdir"), exist_ok=True); open(os.path.join(repo, "tmpdir", "x.dat"), "w").write("x\n")
        open(os.path.join(repo, "a.txt"), "a").write("more\n")
        pg.wait_for_selector(".file-row:has-text('debug.log')", timeout=9000)
        pg.click(".file-row:has-text('a.txt')", button="right")
        check(pg.is_visible(".ctx-menu .ctx-item:has-text('管理しない一覧に追加')") and pg.locator(".ctx-menu .ctx-item:has-text('管理しない一覧に追加')").is_disabled(), "記録済みのファイルでは、項目は出るが押せない")
        pg.keyboard.press("Escape")
        pg.click(".file-row:has-text('debug.log')", button="right")
        pg.click(".ctx-menu .ctx-item:has-text('管理しない一覧に追加')")
        pg.wait_for_selector(".overlay .modal:has-text('管理しないファイルに追加')")
        opts = pg.inner_text(".overlay .modal select")
        check("*.log" in opts and "このファイルだけ" in opts, "「このファイルだけ／同じ種類すべて」を選べる")
        pg.select_option(".overlay .modal select", index=1)
        pg.click(".overlay .modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('*.log')")
        check("*.log" in open(os.path.join(repo, ".gitignore")).read().split("\n"), "選んだパターンが .gitignore に入る")
        pg.wait_for_selector(".file-row:has-text('debug.log')", state="detached", timeout=9000)
        check(True, "追加したファイルは、変更一覧から消える")
        pg.click(".file-row:has-text('x.dat')", button="right")
        pg.click(".ctx-menu .ctx-item:has-text('管理しない一覧に追加')")
        pg.wait_for_selector(".overlay .modal select")
        pg.select_option(".overlay .modal select", label="このフォルダごと（tmpdir/）")
        pg.click(".overlay .modal .btn.primary"); pg.wait_for_selector(".toast:has-text('tmpdir/')")
        check("/tmpdir/" in open(os.path.join(repo, ".gitignore")).read().split("\n"), "フォルダごと追加もできる")
        b.close()
finally:
    bridge.kill()
print("\n結果:", "すべて成功" if not errors else f"失敗 {len(errors)} 件")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
