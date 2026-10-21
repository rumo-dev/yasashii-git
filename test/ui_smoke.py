import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygui-")
repo = os.path.join(tmp, "demo"); os.makedirs(repo)
# ログインは必須なので、ログイン済みの偽 gh を用意して始める
import shutil
binp = os.path.join(tmp, "bin"); os.makedirs(binp); shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("1")
env = dict(os.environ, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=tmp,
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True)
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "Tester"); sh("git", "config", "user.email", "t@e.com")
open(os.path.join(repo, "readme.txt"), "w").write("hello\n"); sh("git", "add", "."); sh("git", "commit", "-m", "最初の記録")
open(os.path.join(repo, "readme.txt"), "w").write("hello\nworld\n")
open(os.path.join(repo, "新規 ファイル.txt"), "w").write("new\n")

bridge = subprocess.Popen(["node", os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE)
bridge.stdout.readline()
def call(ns, fn, *args):
    req = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(args)}).encode())
    return json.loads(urllib.request.urlopen(req).read())

INIT = """
window.api = { call: async (ns, fn, ...args) => { const r = await window.__call(ns, fn, JSON.stringify(args)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  ghLoginWeb: async () => { throw new Error('テスト環境では未対応'); }, onGhLoginCode(){}, onMenu(){}, onProgress(){}, onUpdateState(){} };
"""
errors = []; shots = os.path.join(ROOT, "test", "shots"); os.makedirs(shots, exist_ok=True)
def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: errors.append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1280, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes")
        pg.screenshot(path=shots + "/1_changes.png")
        check("新規 ファイル.txt" in pg.inner_text("#view"), "変更画面に日本語・空白入りのファイル名が出る")
        check(pg.is_visible("text=アップロード") and pg.is_visible("text=最新を取り込む"), "上部バーが日本語（アップロード/最新を取り込む）")
        check("commit" not in pg.inner_text("#nav").lower().replace("(commit)", ""), "サイドバーに英語のGit用語が出ていない")
        # 1つ選んで差分
        pg.click(".file-row:has-text('readme.txt')")
        pg.wait_for_selector(".diff .ln.add")
        check("world" in pg.inner_text(".diff"), "差分が表示される")
        # 部分的に記録（この部分だけ）
        pg.click("text=この部分だけ記録に含める")
        pg.wait_for_selector(".file-row input:checked")
        check(True, "かたまり単位で記録に含められる")
        # 全部含めてコミット
        pg.click("text=すべて含める")
        pg.fill("input[placeholder^='例：トップ']", "文言を追加")
        pg.click(".commit-box .btn.primary")
        pg.wait_for_selector(".toast:has-text('記録しました')")
        check(True, "「変更を記録」でコミットできる")
        pg.screenshot(path=shots + "/2_after_commit.png")
        check("アップロードできます" in pg.inner_text("#hint") or "共有されていません" in pg.inner_text("#hint") or "最新" in pg.inner_text("#hint") or "アップロード" in pg.inner_text("#hint"), "次にやることのヒントが出る: " + pg.inner_text("#hint"))
        # 履歴
        pg.click(".nav-item[data-id=history]")
        pg.wait_for_selector(".commit-row")
        check(pg.locator(".commit-row").count() == 2, "履歴に2件")
        check("文言を追加" in pg.inner_text("#view"), "履歴に新しい記録")
        pg.screenshot(path=shots + "/3_history.png")
        # ブランチ作成
        pg.click(".nav-item[data-id=branches]")
        pg.click("text=新しい作業の分岐を作る")
        pg.fill(".modal input[type=text]", "feature-a")
        pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('作りました')")
        pg.wait_for_selector("text=feature-a")
        check("feature-a" in pg.inner_text("#topbar"), "分岐を作ると上部バーに反映")
        pg.screenshot(path=shots + "/4_branches.png")
        # 不正な名前は日本語エラー
        pg.click("text=新しい作業の分岐を作る"); pg.fill(".modal input[type=text]", "bad name"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".modal:has-text('うまくいきませんでした')")
        check("使えません" in pg.inner_text(".modal"), "不正な分岐名は日本語エラー")
        pg.click(".modal .btn.primary")
        # 一時退避
        open(os.path.join(repo, "readme.txt"), "a").write("more\n")
        pg.click(".nav-item[data-id=changes]"); pg.wait_for_selector(".file-row:has-text('readme.txt')", timeout=8000)
        pg.click(".nav-item[data-id=stash]"); pg.click("text=今の変更をしまう"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('しまいました')")
        pg.wait_for_selector(".row:has-text('stash@')"); check(pg.locator(".row:has-text('stash@')").count() == 1, "一時退避が一覧に出る")
        check("null" not in pg.inner_text("#topbar"), "上部バーに null が表示されない")
        pg.screenshot(path=shots + "/5_stash.png")
        # タグ
        pg.click(".nav-item[data-id=tags]"); pg.click("text=目印をつける >> nth=0"); pg.fill(".modal input[type=text] >> nth=0", "v1.0"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".row:has-text('v1.0')"); check(True, "目印を作れる")
        # 設定
        pg.click(".nav-item[data-id=settings]"); pg.wait_for_selector("text=記録に残す名前")
        pg.screenshot(path=shots + "/6_settings.png")
        # GitHub（gh の有無で分岐）
        pg.click(".nav-item[data-id=github]"); pg.wait_for_selector(".tabs")
        pg.wait_for_function("document.querySelector('.empty') == null || !document.querySelector('.empty').innerText.includes('確認中')", timeout=15000)
        pg.screenshot(path=shots + "/7_github.png")
        check(pg.is_visible(".tabs"), "GitHub画面が表示される")
        # 用語集
        pg.click("#glossaryBtn"); pg.wait_for_selector(".glossary")
        check("push" in pg.inner_text(".glossary"), "用語の対応表にpushの対応がある")
        pg.keyboard.press("Escape")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    try: print("ページ内エラー:", errors); print("画面:", pg.inner_text("body")[:500])
    except Exception: pass
    errors.append("例外")
finally:
    bridge.terminate()
print("\n結果:", "失敗 %d 件" % len(errors) if errors else "すべて成功")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
