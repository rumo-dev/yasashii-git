# リリースの生成：GitHub画面の「リリース」タブ／目印からの「リリースにする」。偽gh（test/fake_gh.sh）とローカルのbareリポジトリで確認。
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygrl-")
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
def commit(msg):
    open(os.path.join(repo, "a.txt"), "a").write(msg + "\n"); sh("git", "add", "."); sh("git", "commit", "-qm", msg)
commit("最初の記録"); sh("git", "tag", "-a", "v1.0.0", "-m", "初版"); commit("ログイン画面を追加"); commit("文言を直した")
sh("git", "push", "-q", "-u", "origin", "main", "--tags")
open(state + ".reltags", "w").write("v1.0.0\n")

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
  ghLoginWeb: async () => ({}), onGhLoginCode() {}, onMenu() {}, onProgress() {}, onUpdateState() {} };
"""
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
DLG = ".overlay .modal"
def ref(): return sh("git", "--git-dir", bare, "tag", "-l")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 900})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: handler(ns, fn, a))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes", timeout=15000)

        pg.click(".nav-item[data-id=github]"); pg.click(".tab:has-text('リリース')")
        pg.wait_for_selector(".row:has-text('v1.0.0')")
        check(pg.is_visible(".row:has-text('v1.0.0'):has-text('最新')"), "「リリース」タブに、既存のリリースが出る")

        print("【リリースを作る】")
        pg.click("button:has-text('リリースを作る')")
        pg.wait_for_selector(f"{DLG}:has-text('リリースを作る')")
        vals = pg.eval_on_selector_all(f"{DLG} input[type=text]", "els => els.map(e => e.value)")
        notes = pg.input_value(f"{DLG} textarea")
        check(vals[0] == "v1.0.1", "次のバージョン名（v1.0.1）が自動で入る: " + vals[0])
        check("ログイン画面を追加" in notes and "文言を直した" in notes and "最初の記録" not in notes, "前のバージョンからの記録だけが、リリースノートの下書きになる")
        check("v1.0.0" in pg.inner_text(DLG), "前のバージョンが説明に出る")
        pg.screenshot(path="/tmp/ygrl_1_dialog.png")
        pg.fill(f"{DLG} input[type=text] >> nth=1", "ログイン機能を追加")
        pg.fill(f"{DLG} textarea", notes + "\n- 手で追記した行\n")
        pg.click(f"{DLG} .btn.primary")
        pg.wait_for_selector(f"{DLG}:has-text('リリースを作りました')", timeout=30000)
        check("v1.0.1" in ref().split("\n"), "目印がサーバーに送られた")
        log = open(state + ".rellog").read()
        check("v1.0.1" in log and "ログイン機能を追加" in log and "手で追記した行" in log and "--verify-tag" in log and "--draft" not in log, "GitHubのリリースが、タイトル・ノートつきで作られた")
        check(sh("git", "tag", "-l", "v1.0.1").strip() == "v1.0.1", "手元にも目印ができた")
        pg.click(f"{DLG} button:has-text('ブラウザで開く')")
        pg.wait_for_function("true")
        check(opened and opened[-1].endswith("/releases/tag/v1.0.1"), "「ブラウザで開く」でリリースのページを開く")
        pg.wait_for_selector(".row:has-text('v1.0.1')", timeout=15000)

        print("【まだ送っていない記録がある】")
        commit("あとから足した記録")
        pg.click("button:has-text('リリースを作る')")
        pg.wait_for_selector(f"{DLG}:has-text('先にアップロードしますか')")
        check(True, "未アップロードの記録があると、先にアップロードを提案する")
        pg.click(f"{DLG} .btn.primary")
        pg.wait_for_selector(f"{DLG}:has-text('リリースを作る')", timeout=30000)
        check("あとから足した記録" in sh("git", "--git-dir", bare, "log", "main", "--format=%s"), "アップロードされてから、リリースの入力に進む")
        check(pg.input_value(f"{DLG} input[type=text] >> nth=0") == "v1.0.2", "バージョン名は v1.0.2 になる")

        print("【同じ名前・下書き】")
        pg.fill(f"{DLG} input[type=text] >> nth=0", "v1.0.1")
        pg.click(f"{DLG} .btn.primary")
        pg.wait_for_selector(f"{DLG}:has-text('すでにGitHubにあります')", timeout=30000)
        check(True, "すでにあるバージョン名なら、やさしい日本語で伝える")
        pg.click(f"{DLG} button:has-text('閉じる')")
        pg.click("button:has-text('リリースを作る')"); pg.wait_for_selector(f"{DLG}:has-text('リリースを作る')")
        pg.fill(f"{DLG} input[type=text] >> nth=0", "v 2")
        pg.click(f"{DLG} .btn.primary")
        pg.wait_for_selector(".toast:has-text('空白')")
        check(True, "空白入りのバージョン名は、その場で止める")
        pg.keyboard.press("Escape")

        print("【目印の画面から】")
        pg.click(".nav-item[data-id=tags]"); pg.wait_for_selector(".row:has-text('v1.0.0')")
        pg.click(".row:has-text('v1.0.0') button:has-text('リリースにする')")
        pg.wait_for_selector(f"{DLG}:has-text('リリースを作る')")
        check(pg.input_value(f"{DLG} input[type=text] >> nth=0") == "v1.0.0", "目印の行の「リリースにする」で、その目印が入る")
        b.close()
finally:
    bridge.kill()
print("\n結果:", "すべて成功" if not errors else f"失敗 {len(errors)} 件")
for e in errors: print(" -", e)
sys.exit(1 if errors else 0)
