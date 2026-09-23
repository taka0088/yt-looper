#!/bin/bash
# YT LOOPER のサーバー（と、動いていればパート分離のサーバー）を止める
lsof -tiTCP:8765 -sTCP:LISTEN | xargs kill 2>/dev/null && echo "止めました" || echo "動いていません"
lsof -tiTCP:8766 -sTCP:LISTEN | xargs kill 2>/dev/null && echo "分離サーバーも止めました"
