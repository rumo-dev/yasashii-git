@echo off
chcp 65001 >nul
cd /d "%~dp0"
title やさしいGit

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo https://nodejs.org/ja から「LTS」版をインストールしてから、もう一度実行してください。
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo [注意] Git が見つかりません。https://git-scm.com/ からインストールしてください。
  pause
)

if not exist node_modules (
  echo 初回の準備をしています。数分かかることがあります...
  call npm install
  if errorlevel 1 (
    echo [エラー] 準備に失敗しました。インターネット接続を確認してください。
    pause
    exit /b 1
  )
)

echo やさしいGit を起動しています...
start "" /b cmd /c "npm start >nul 2>nul"
exit /b 0
