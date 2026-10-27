'use strict';
const assert = require('assert');
const { openWindowsTerminal } = require('../src/windows-terminal');

(async () => {
  const dir = "C:\\開発\\space & (test)\\O'Brien $value `test` %PATH%";
  let invoked = false;
  const result = await openWindowsTerminal(dir, { windowsRoot: 'C:\\Windows', exec: (file, args, options, callback) => {
    invoked = true;
    assert.strictEqual(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.strictEqual(options.cwd, dir);
    assert.strictEqual(options.windowsHide, true);
    assert.ok(args.includes('-NonInteractive'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes('-WindowStyle Normal'));
    assert.ok(script.includes("$ErrorActionPreference = 'Stop'"));
    assert.ok(script.includes("-WorkingDirectory '" + dir.replace(/'/g, "''") + "'"));
    const encoded = script.match(/-NoExit -EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
    assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), "Set-Location -LiteralPath '" + dir.replace(/'/g, "''") + "'");
    callback(null, '', '');
  } });
  assert.strictEqual(result, true); assert.ok(invoked);
  await assert.rejects(openWindowsTerminal(dir, { exec: (_, __, ___, callback) => callback(new Error('failed'), '', '起動が拒否されました') }), /ターミナルを開けませんでした：起動が拒否されました/);
  await assert.rejects(openWindowsTerminal(dir, { exec: (_, __, ___, callback) => callback(new Error('ENOENT'), '', '') }), /ENOENT/);
  console.log('  ✓ ターミナル：可視ウィンドウの起動・特殊文字を含むパス・起動失敗の通知');
})().catch((error) => { console.error(error); process.exitCode = 1; });
