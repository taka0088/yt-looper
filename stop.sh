#!/bin/bash
# YT LOOPER のサーバー（と、動いていればパート分離のサーバー）を止める。
# 自動起動の設定も今回は外すので、次に Mac を起動するか YT LOOPER.app を開くまで止まったまま
for a in com.ytlooper.web com.ytlooper.stems; do
  launchctl bootout "gui/$(id -u)/$a" 2>/dev/null
done
sleep 0.5
lsof -tiTCP:8765 -sTCP:LISTEN | xargs kill 2>/dev/null
lsof -tiTCP:8766 -sTCP:LISTEN | xargs kill 2>/dev/null
echo "止めました（次に Mac を起動するか、YT LOOPER.app を開くとまた動きます）"
