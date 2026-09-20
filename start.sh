#!/bin/bash
# ループ練習を起動する：サーバーが動いていなければ起動し、ブラウザで開く
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$DIR" && nohup python3 serve.py $PORT >/dev/null 2>&1 &
  sleep 1
fi
open "http://localhost:$PORT"
