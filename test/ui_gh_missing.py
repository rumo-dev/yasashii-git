# gh が無い環境での案内ポップアップの検証
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp(prefix="yggh-"); binp = os.path.join(tmp, "bin"); os.makedirs(binp)
os.symlink(shutil.which("git"), os.path.join(binp, "git"))   # git だけを見える状態にする（gh は隠す）
repo = os.path.join(tmp, "p"); os.makedirs(repo)
env = dict(os.environ, HOME=tmp, PATH=binp, YG_NO_PATH_EXTEND="1", YG_REPO=repo, GIT_CONFIG_GLOBAL=os.path.join(tmp, ".gitconfig"))
subprocess.run(["git", "init", "-b", "main"], cwd=repo, env=env, check=True, capture_output=True)
bridge = subprocess.Popen([shutil.which("node"), os.path.join(ROOT, "test/bridge.js")], env=env, stdout=subprocess.PIPE); bridge.stdout.readline()
def call(ns, fn, *a):
    r = urllib.request.Request("http://127.0.0.1:4599/", data=json.dumps({"ns": ns, "fn": fn, "args": list(a)}).encode())
    return json.loads(urllib.request.urlopen(r).read())
INIT = "window.api={call:async(ns,fn,...a)=>{const r=await window.__call(ns,fn,JSON.stringify(a));if(r.ok)return r.value;const e=new Error(r.error.message);e.detail=r.error.detail;throw e},onGhLoginCode(){},onMenu(){},onProgress(){},onUpdateState(){}};"
ok = True
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1100, "height": 700}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.expose_function("__call", lambda ns, fn, a: call(ns, fn, *json.loads(a)))
        pg.add_init_script(INIT); pg.goto("file://" + os.path.join(ROOT, "renderer/index.html"))
        pg.wait_for_selector("button:has-text('インストールする')", timeout=15000)
        print("  ✓ gh が無いと、入り口の画面にインストールの案内が出る（先へは進めない）")
        assert pg.is_hidden("#sidebar")
        pg.screenshot(path=os.path.join(tmp, "gh_gate.png")); shutil.copy(os.path.join(tmp, "gh_gate.png"), "/tmp/gh_gate.png")
        pg.click("button:has-text('インストールする')"); pg.wait_for_selector(".modal:has-text('GitHub CLI')")
        print("  ✓ 押すと案内が開く（この環境は自動導入非対応のため手動案内）")
        if errs: print("  ✗ ページ内エラー", errs); ok = False
        b.close()
finally:
    bridge.terminate()
sys.exit(0 if ok else 1)
