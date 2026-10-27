'use strict';

const { execFile } = require('child_process');
const path = require('path');

const literal = (value) => "'" + value.replace(/'/g, "''") + "'";
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function openWindowsTerminal(dir, { exec = execFile, windowsRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = encode(`Set-Location -LiteralPath ${literal(dir)}`);
  // 非表示のランチャーから新しいウィンドウを作成する。プロジェクトのパスは
  // cmd.exe を経由させず、PowerShell の文字列リテラルと EncodedCommand で渡す。
  const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal(powershell)} -WorkingDirectory ${literal(dir)} -WindowStyle Normal -ArgumentList '-NoLogo -NoProfile -NoExit -EncodedCommand ${command}'`;
  return new Promise((resolve, reject) => {
    exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)],
      { cwd: dir, windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error('ターミナルを開けませんでした：' + (String(stderr || '').trim() || error.message)));
        resolve(true);
      });
  });
}

module.exports = { openWindowsTerminal };
