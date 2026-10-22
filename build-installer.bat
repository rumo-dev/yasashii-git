@echo off
chcp 65001 >nul
cd /d "%~dp0"
title やさしいGit - インストーラー作成

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。https://nodejs.org/ja からインストールしてください。
  pause
  exit /b 1
)

echo [1/2] 必要なものを準備しています...
call npm install --no-audit --no-fund --progress=true --loglevel=info --fetch-retries=2 --fetch-timeout=120000 --foreground-scripts
if errorlevel 1 (
  echo [エラー] 準備に失敗しました。
  echo npmの詳しい記録は %LOCALAPPDATA%\npm-cache\_logs にあります。
  pause
  exit /b 1
)

echo [2/2] Windows用のインストーラーを作成しています。数分かかります...
call npm run dist:win
if errorlevel 1 ( echo [エラー] 作成に失敗しました。 & pause & exit /b 1 )

echo.
echo ===== 完成しました =====
echo dist フォルダに、次のファイルができています：
echo   ・やさしいGit-...-Windows-x64.exe  （インストーラー／配布用）
echo   ・ポータブル版 .exe                 （インストール不要で動くもの）
start "" "%~dp0dist"
pause
