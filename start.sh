#!/bin/bash
# YT LOOPER を起動する：サーバーが動いていなければ起動し、ブラウザで開く
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$DIR" && nohup python3 serve.py $PORT >/dev/null 2>&1 &
  sleep 1
fi

# パート分離（~/YouTubeパート分離 があるときだけ）。8766 番で待つ
STEM="$HOME/YouTubeパート分離"
if [ -x "$STEM/venv/bin/python" ] && [ -f "$STEM/stem_server.py" ] \
   && ! lsof -iTCP:8766 -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$STEM" && nohup ./venv/bin/python stem_server.py >> "$STEM/server.log" 2>&1 &
fi

open "http://localhost:$PORT"
