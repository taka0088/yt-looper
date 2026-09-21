#!/bin/sh
# 公開手順：index.html の style.css / app.js に版番号を付けてから commit & push する。
# GitHub Pages は 10 分キャッシュするので、版番号を変えないと iPhone が古い JS を使い続ける。
set -e
cd "$(dirname "$0")"
BUILD=$(date +%Y%m%d-%H%M)
sed -i '' -E "s/(style\.css\?v=)[0-9A-Za-z-]+/\1$BUILD/; s/(app\.js\?v=)[0-9A-Za-z-]+/\1$BUILD/; s/build [0-9A-Za-z-]+</build $BUILD</" index.html
git add -A
git commit -q -m "${1:-更新} (build $BUILD)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -q
echo "pushed build $BUILD"
