# 名前・メールの自動設定：ログイン直後にGitHubアカウントから自動で入る／既存の設定は上書きしない／設定画面のボタンで自動入力できる
# 本物のGitHubには接続せず、test/fake_gh.sh（偽のgh）を使う。
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygusr-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("")   # ログイン済み
gcfg = os.path.join(tmp, ".gitconfig"); open(gcfg, "w").write("")       # 名前もメールも未設定
repo = os.path.join(tmp, "proj"); os.makedirs(repo)
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=gcfg, YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo, ok=True): return subprocess.run(a, cwd=cwd, env=env, check=ok, capture_output=True, text=True).stdout
def gcfg_get(k): return sh("git", "config", "--global", "--get", k, cwd=tmp, ok=False).strip()
sh("git", "init", "-b", "main")   # ← ここでは user.name / user.email を設定しない
open(os.path.join(repo, "a.txt"), "w").write("hello\n")

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
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))

        # 1. ログイン直後、未設定なら GitHub のアカウント情報から自動で設定される
        pg.wait_for_selector(".toast:has-text('自動で設定しました')", timeout=15000)
        check(gcfg_get("user.name") == "テスト 太郎", "名前がGitHubの表示名から自動設定された: " + gcfg_get("user.name"))
        check(gcfg_get("user.email") == "4242+tester@users.noreply.github.com", "メールはGitHubの非公開用アドレスになる（本当のメールは使わない）: " + gcfg_get("user.email"))

        # 2. そのまま「変更を記録」できる（名前が無いエラーにならない）
        pg.wait_for_selector(".split.changes", timeout=15000)
        pg.click(".file-row:has-text('a.txt')")
        pg.fill("input[placeholder^='例：トップ']", "最初の記録")
        pg.click(".commit-box button.primary")
        pg.wait_for_selector(".toast:has-text('記録しました')", timeout=15000)
        check("テスト 太郎" in sh("git", "log", "-1", "--format=%an <%ae>") and "4242+tester@users.noreply.github.com" in sh("git", "log", "-1", "--format=%ae"), "記録の作成者に自動設定の名前・メールが入る")
        pg.screenshot(path="/tmp/ygusr_1_auto.png")

        # 3. すでに設定がある場合は、起動し直しても上書きしない
        sh("git", "config", "--global", "user.name", "自分で決めた名前", cwd=tmp); sh("git", "config", "--global", "user.email", "me@example.com", cwd=tmp)
        pg.reload(); pg.wait_for_selector(".split.changes", timeout=15000)
        pg.wait_for_timeout(800)
        check(gcfg_get("user.name") == "自分で決めた名前" and gcfg_get("user.email") == "me@example.com", "すでにある設定は上書きされない")
        check(pg.locator(".toast:has-text('自動で設定しました')").count() == 0, "設定済みなら「自動で設定しました」は出ない")

        # 4. 設定画面のボタンで、いつでも自動入力できる（入力欄に入るだけ。「保存」で反映）
        pg.click(".nav-item[data-id=settings]")
        pg.wait_for_selector("button:has-text('GitHubアカウントから自動入力')")
        pg.click("button:has-text('GitHubアカウントから自動入力')")
        for _ in range(100):   # 入力欄にメールが入るまで待つ（画面のCSPが文字列評価を禁止しているため、Python側で確認）
            if "noreply" in pg.input_value("input[placeholder='you@example.com']"): break
            pg.wait_for_timeout(100)
        check(pg.input_value("input[placeholder='例：山田 太郎']") == "テスト 太郎", "設定画面のボタンで名前が入力される")
        check(gcfg_get("user.name") == "自分で決めた名前", "押しただけでは保存されない（保存ボタンで反映）")
        pg.locator(".card:has-text('記録に残す名前') .btn.primary").first.click()
        pg.wait_for_selector(".toast:has-text('保存しました')")
        check(gcfg_get("user.name") == "テスト 太郎" and gcfg_get("user.email") == "4242+tester@users.noreply.github.com", "「保存」で反映される")
        pg.screenshot(path="/tmp/ygusr_2_settings.png")

        # 5. 取得できない（オフライン等）場合は、記録の前に設定画面へ案内する
        os.remove(gcfg); open(gcfg, "w").write("")
        os.rename(os.path.join(binp, "gh"), os.path.join(binp, "gh.off"))   # gh が使えない状態
        pg.click(".nav-item[data-id=changes]")
        open(os.path.join(repo, "b.txt"), "w").write("b\n")
        pg.wait_for_selector(".file-row:has-text('b.txt')", timeout=8000)
        pg.click(".file-row:has-text('b.txt')")
        pg.fill("input[placeholder^='例：トップ']", "2回目")
        pg.click(".commit-box button.primary")
        pg.wait_for_selector(".toast:has-text('名前」と「メールアドレス」を設定')", timeout=10000)
        pg.wait_for_selector("button:has-text('GitHubアカウントから自動入力')")
        check(True, "自動で設定できないときは、エラーで止まらず「設定」画面へ案内される")
        pg.click(".nav-item[data-id=changes]"); pg.wait_for_selector("input[placeholder^='例：トップ']")
        check(pg.input_value("input[placeholder^='例：トップ']") == "2回目", "設定画面から戻っても、書いたメモの下書きは残っている")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    try: pg.screenshot(path="/tmp/ygusr_fail.png"); print("画面:", pg.inner_text("body")[:600])
    except Exception: pass
    errors.append("例外")
finally:
    bridge.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print("\n結果: すべて成功" if not errors else f"\n結果: 失敗 {len(errors)} 件\n" + "\n".join(" - " + e for e in errors))
sys.exit(1 if errors else 0)
