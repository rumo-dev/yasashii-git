# アップロード前の安全チェック：.env などを検出して止める／直し方どおりに直すと送れる／100MB超は送れない／軽い注意は進める／設定でオフにできる
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="ygsafe-")
binp = os.path.join(tmp, "bin"); os.makedirs(binp)
shutil.copy(os.path.join(ROOT, "test/fake_gh.sh"), os.path.join(binp, "gh")); os.chmod(os.path.join(binp, "gh"), 0o755)
remotes = os.path.join(tmp, "remotes"); os.makedirs(remotes)
state = os.path.join(tmp, "gh_logged_in"); open(state, "w").write("")
repo = os.path.join(tmp, "proj"); os.makedirs(repo)
bare = os.path.join(tmp, "server.git")
env = dict({k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}, HOME=tmp, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"), YG_REPO=repo, FAKE_GH_STATE=state, FAKE_GH_REMOTES=remotes, GIT_CONFIG_NOSYSTEM="1",
           PATH=binp + os.pathsep + os.environ["PATH"], YG_NO_PATH_EXTEND="1")
def sh(*a, cwd=repo): return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
def W(name, text="x\n"): open(os.path.join(repo, name), "w").write(text)
def server_log(): return sh("git", "--git-dir", bare, "log", "main", "--format=%s", cwd=tmp)
def server_files(): return sh("git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "main", cwd=tmp)
sh("git", "init", "-q", "--bare", "-b", "main", bare, cwd=tmp)
sh("git", "init", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@e.com")
W("a.txt", "1\n"); sh("git", "add", "."); sh("git", "commit", "-qm", "最初の記録")
sh("git", "remote", "add", "origin", bare); sh("git", "push", "-q", "-u", "origin", "main")

bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())
INIT = """
window.api = { call: async (ns, fn, ...a) => { if (window.__failSafetyOnce && ns === 'git' && fn === 'safetyCheck') { window.__failSafetyOnce = false; throw new Error('テスト用の安全チェック失敗'); } const r = await window.__call(ns, fn, JSON.stringify(a)); if (r.ok) return r.value; const e = new Error(r.error.message); e.detail = r.error.detail; throw e; },
  ghLoginWeb: async () => ({}), onGhLoginCode() {}, onMenu() {}, onProgress() {}, onUpdateState() {} };
"""
errors = []
def check(c, m):
    print(("  ✓ " if c else "  ✗ ") + m)
    if not c: errors.append(m)
MEMO = "input[placeholder^='例：トップ']"
DLG = ".modal"
def clear_toasts(pg): pg.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox", "--allow-file-access-from-files"])
        pg = b.new_page(viewport={"width": 1200, "height": 850})
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT)
        pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector(".split.changes", timeout=15000)

        # 1. 問題のない記録は、確認なしでそのまま送れる
        W("readme.md", "こんにちは\n"); pg.wait_for_selector(".file-row:has-text('readme.md')", timeout=9000)
        pg.fill(MEMO, "説明を追加"); pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("説明を追加" in server_log() and pg.locator(DLG).count() == 0, "問題がなければ、確認ダイアログなしでアップロードできる")

        # 2. .env を入れて送ろうとすると止まる
        W(".env", "SECRET_KEY=abc123\n"); W("page.html", "<p>hi</p>\n"); pg.wait_for_selector(".file-row:has-text('.env')", timeout=9000)
        pg.fill(MEMO, "ページを追加"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('送る前に確認してください')", timeout=15000)
        check(pg.is_visible(f"{DLG}:has-text('環境設定ファイル')") and pg.is_visible(f"{DLG}:has-text('要注意')"), ".env が「要注意」として表示される")
        check(not pg.is_visible(f"{DLG}:has-text('page.html')"), "問題のないファイルは一覧に出ない")
        pg.screenshot(path="/tmp/ygsafe_1_env.png")
        check(pg.evaluate("document.activeElement.textContent") == "やめる", "初期フォーカスは安全な「やめる」側")
        pg.click(f"{DLG} button:has-text('管理しない一覧に追加')")
        pg.wait_for_selector(f"{DLG} button:has-text('追加しました')")
        check("/.env" in open(os.path.join(repo, ".gitignore")).read().split("\n"), "「管理しない一覧に追加」で .gitignore に入る")
        pg.click(f"{DLG} button:has-text('やめる')")
        pg.wait_for_selector(".toast:has-text('アップロードを中止しました')")
        check("ページを追加" not in server_log(), "「やめる」を押すと、何も送られない")

        # 3. 直し方のとおり：記録を取り消す → .env を外す → もう一度記録して送る
        pg.click("button:has-text('直前の記録を取り消す')"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('取り消しました')")
        pg.wait_for_selector(".file-row:has-text('.env')")
        pg.click(".file-row:has-text('.env') input[type=checkbox]")
        pg.wait_for_selector(".file-row:has-text('page.html')")
        pg.fill(MEMO, "ページを追加（直した）"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("直した" in server_log() and ".env" not in server_files().split("\n") and pg.locator(DLG).count() == 0, "直し方どおりにすると、.env を含めずに送れる")

        # 4. 100MBを超えるファイルは送れない（「それでも送る」が出ない）
        with open(os.path.join(repo, "huge.bin"), "wb") as f: f.truncate(101 * 1024 * 1024)
        pg.wait_for_selector(".file-row:has-text('huge.bin')", timeout=15000)
        pg.fill(MEMO, "巨大ファイル"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('このままでは送れません')", timeout=30000)
        check(pg.is_visible(f"{DLG}:has-text('送れません')") and pg.is_visible(f"{DLG}:has-text('101 MB')"), "100MB超は「送れません」と大きさつきで表示される")
        check(pg.locator(f"{DLG} button:has-text('それでも送る')").count() == 0, "送れないものには「それでも送る」を出さない")
        pg.screenshot(path="/tmp/ygsafe_2_big.png")
        pg.click(f"{DLG} button:has-text('やめる')")
        pg.click("button:has-text('直前の記録を取り消す')"); pg.click(".modal .btn.primary")
        pg.wait_for_selector(".toast:has-text('取り消しました')")
        os.remove(os.path.join(repo, "huge.bin")); sh("git", "reset", "-q")

        # 5. 念のための注意（パスワードらしき記述）は、確認のうえ進める
        W("config.py", 'DB_PASSWORD = "realsecret123"\n'); pg.wait_for_selector(".file-row:has-text('config.py')", timeout=9000)
        pg.fill(MEMO, "設定を追加"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('送る前の確認')", timeout=15000)
        check(pg.is_visible(f"{DLG}:has-text('念のため')") and pg.is_visible(f"{DLG}:has-text('config.py の 1 行目')"), "パスワードらしき記述が、ファイル名と行番号つきで「念のため」と表示される")
        check("realsecret123" not in pg.inner_text(DLG), "画面に秘密の値そのものは表示しない")
        pg.click(f"{DLG} button:has-text('それでも送る')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("設定を追加" in server_log(), "「それでも送る」を選ぶと送られる")

        # 6. 安全チェックに失敗したら知らせ、再試行が選べる
        W("retry.txt", "安全チェックを再試行\n"); pg.wait_for_selector(".file-row:has-text('retry.txt')", timeout=9000)
        pg.evaluate("window.__failSafetyOnce = true")
        pg.fill(MEMO, "安全チェック失敗の再試行"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(f"{DLG}:has-text('安全チェックを完了できませんでした')", timeout=15000)
        check(pg.is_visible(f"{DLG}:has-text('もう一度確認')") and pg.is_visible(f"{DLG}:has-text('確認せずに続ける')"), "安全チェック失敗時に再試行・明示的な続行を選べる")
        check("安全チェック失敗の再試行" not in server_log(), "安全チェック失敗のままではアップロードされない")
        pg.click(f"{DLG} button:has-text('もう一度確認')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("安全チェック失敗の再試行" in server_log(), "再試行が成功するとアップロードできる")

        # 7. 設定でオフにすると、確認なしで送れる
        pg.click(".nav-item[data-id=settings]")
        pg.wait_for_selector("text=アップロード前の安全チェック")
        pg.click(".card:has-text('アップロード前の安全チェック') input[type=checkbox]")
        pg.wait_for_selector(".toast:has-text('オフにしました')")
        pg.click(".nav-item[data-id=changes]")
        W("credentials.json", "{}\n"); pg.wait_for_selector(".file-row:has-text('credentials.json')", timeout=9000)
        pg.fill(MEMO, "オフのとき"); clear_toasts(pg)
        pg.click("button:has-text('記録して、そのままアップロード')")
        pg.wait_for_selector(".toast:has-text('アップロードしました')", timeout=20000)
        check("オフのとき" in server_log() and pg.locator(DLG).count() == 0, "設定でオフにすると、確認なしで送れる")
        b.close()
except Exception as ex:
    print("EXCEPTION:", str(ex).splitlines()[0])
    try: pg.screenshot(path="/tmp/ygsafe_fail.png"); print("画面:", pg.inner_text("body")[:700])
    except Exception: pass
    errors.append("例外")
finally:
    bridge.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print("\n結果: すべて成功" if not errors else f"\n結果: 失敗 {len(errors)} 件\n" + "\n".join(" - " + e for e in errors))
sys.exit(1 if errors else 0)
