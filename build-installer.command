#!/bin/bash
cd "$(dirname "$0")"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
npm install && npm run dist:mac && { echo "完成：dist フォルダを確認してください"; open dist; }
read -p "Enterで閉じる"
