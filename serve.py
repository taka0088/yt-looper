#!/usr/bin/env python3
"""YT LOOPER のローカルサーバー。
標準の http.server に「キャッシュしない」ヘッダーを足したもの。
これがないと、ブラウザが古い app.js / index.html を使い回して動かなくなることがある。"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静かに（必要なら消す）
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

if __name__ == "__main__":
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"YT LOOPER: http://localhost:{PORT}")
        httpd.serve_forever()
