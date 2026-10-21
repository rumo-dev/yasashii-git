# 自動ひと言メモ：変更したファイルから「記録のメモ」の下書きが入る／選び直すと追従する／本人が書いたメモは上書きしない
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygmemo-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("")
repo = os.path.join(tmp, "proj"); os.makedirs(repo)
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
def W(name, text="x\n"): open(os.path.join(repo, name), "w").write(text)
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
W("a.txt", "1\n"); sh("git", "add", "."); sh("git", "commit", "-qm", "init")
W("a.txt", "2\n"); W("b.css")     # 変更1つ＋新規1つ

bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())
INIT = """
window.api = { call: async (ns, fn, ...a) => { const r = await window.__call(ns, fn, JSON.stringify(a)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  ghLoginWeb: async () => ({}), onGhLoginCode() {}, onMenu() {}, onProgress() {}, onUpdateState() {} };
"""
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
MEMO = "input[placeholder^='例：トップ']"
def wait_memo(pred, timeout=9000):
    """メモ欄の値が条件を満たすまで待つ（画面のCSPが文字列評価を禁止しているため、Python側で確認する）"""
    for _ in range(timeout // 100):
        if pred(pg.input_value(MEMO)): return True
        pg.wait_for_timeout(100)
    return False
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes", timeout=15000)
        pg.wait_for_selector(".file-row:has-text('b.css')")

        # 1. 何も書かなくても、変更したファイル名から下書きが入っている
        check(pg.input_value(MEMO) == "a.txt を変更、b.css を追加", "メモ欄に下書きが自動で入る: " + pg.input_value(MEMO))
        check(pg.is_visible(".auto-memo:has-text('自動で入れました')"), "「自動で入れました。自由に書き換えられます」と案内される")
        pg.screenshot(path="/tmp/ygmemo_1_auto.png")

        # 2. 「記録に含めるファイル」を選ぶと、下書きも追従する
        pg.click(".file-row:has-text('b.css') input[type=checkbox]")
        check(wait_memo(lambda v: v == "b.css を追加"), "ファイルを選ぶと、下書きがそのファイルだけの内容に変わる: " + pg.input_value(MEMO))

        # 3. 本人が書き換えたメモは、ファイルが増えても上書きされない
        pg.fill(MEMO, "自分で書いたメモ")
        W("c.txt")
        pg.wait_for_selector(".file-row:has-text('c.txt')", timeout=9000)
        pg.wait_for_timeout(500)
        check(pg.input_value(MEMO) == "自分で書いたメモ", "自分で書いたメモは、変更が増えても上書きされない")
        check(pg.is_visible(".auto-memo button:has-text('下書きを入れる')"), "「変更したファイルから下書きを入れる」で入れ直せる")

        # 4. 自分で消した場合も、勝手に戻らない
        pg.fill(MEMO, "")
        W("d.txt")
        pg.wait_for_selector(".file-row:has-text('d.txt')", timeout=9000)
        pg.wait_for_timeout(500)
        check(pg.input_value(MEMO) == "", "自分で空にしたメモは、勝手に埋め戻されない")

        # 5. 入れ直し → そのまま記録できる
        pg.click(".auto-memo button:has-text('下書きを入れる')")
        check(pg.input_value(MEMO) == "b.css を追加", "ボタンで下書きを入れ直せる: " + pg.input_value(MEMO))
        pg.click(".commit-box button.primary")
        pg.wait_for_selector(".toast:has-text('記録しました')", timeout=15000)
        check(sh("git", "log", "-1", "--format=%s").strip() == "b.css を追加", "自動の下書きのまま記録できる")

        # 6. 記録後、残りの変更に合わせた新しい下書きが入る（前のメモは残らない）
        wait_memo(lambda v: len(v) > 0 and "b.css" not in v)
        v = pg.input_value(MEMO)
        check("a.txt" in v and "b.css" not in v, "記録のあとは、残った変更に合わせた下書きになる: " + v)
        pg.screenshot(path="/tmp/ygmemo_2_after.png")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    try: pg.screenshot(path="/tmp/ygmemo_fail.png"); print("画面:", pg.inner_text("body")[:600])
    except Exception: pass
    errors.append("例外")
finally:
    bridge.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print("\n結果: すべて成功" if not errors else f"\n結果: 失敗 {len(errors)} 件\n" + "\n".join(" - " + e for e in errors))
sys.exit(1 if errors else 0)
