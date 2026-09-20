#!/bin/bash
# YT LOOPER のサーバーを止める
lsof -tiTCP:8765 -sTCP:LISTEN | xargs kill 2>/dev/null && echo "止めました" || echo "動いていません"
