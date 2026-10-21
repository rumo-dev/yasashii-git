#!/bin/bash
cd "$(dirname "$0")"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || { echo "Node.js が見つかりません。https://nodejs.org/ja からインストールしてください。"; read -p "Enterで閉じる"; exit 1; }
[ -d node_modules ] || { echo "初回の準備をしています…"; npm install || { read -p "失敗しました。Enterで閉じる"; exit 1; }; }
npm start
