#!/bin/bash
# YT LOOPER を起動する：サーバーが動いていなければ起動し、ブラウザで開く
# ふだんは Mac の起動時に自動で動いている（~/Library/LaunchAgents/com.ytlooper.*.plist）。
# stop.sh で止めたあとなどは、ここで自動起動の設定を読み込み直して動かす
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
AGENTS="$HOME/Library/LaunchAgents"

# 自動起動の設定があればそれで動かす（止まっても起動し直してくれる）。なければ直接動かす
up() {  # up <名前> <ポート> <直接動かすコマンド>
  lsof -iTCP:$2 -sTCP:LISTEN >/dev/null 2>&1 && return
  if [ -f "$AGENTS/$1.plist" ]; then
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist" 2>/dev/null
    launchctl kickstart "gui/$(id -u)/$1" 2>/dev/null
  else
    eval "$3"
  fi
}

up com.ytlooper.web $PORT 'cd "$DIR" && nohup python3 serve.py $PORT >/dev/null 2>&1 &'

# パート分離（~/YouTubeパート分離 があるときだけ）。8766 番で待つ
STEM="$HOME/YouTubeパート分離"
if [ -x "$STEM/venv/bin/python" ] && [ -f "$STEM/stem_server.py" ]; then
  up com.ytlooper.stems 8766 'cd "$STEM" && nohup ./venv/bin/python stem_server.py >> "$STEM/server.log" 2>&1 &'
fi

for i in 1 2 3 4 5 6 7 8 9 10; do
  lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.3
done
open "http://localhost:$PORT"
