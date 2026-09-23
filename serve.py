#!/usr/bin/env python3
"""YT LOOPER のローカルサーバー。
標準の http.server に「キャッシュしない」ヘッダーを足したもの。
これがないと、ブラウザが古い app.js / index.html を使い回して動かなくなることがある。

/stems/<動画ID>/<パート>.m4a では、~/YouTubeパート分離 が分けた音を配る。
iPhone の Safari は、別のポートから読んだ音を Web Audio に通すと無音にしてしまうので、
分けた音はページと同じこのサーバーから出す。"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
STEM_DIR = os.path.expanduser("~/YouTubeパート分離/cache/stems")
STEM_PATH = re.compile(r"/stems/([A-Za-z0-9_-]{11})/(drums|bass|other|vocals|guitar|piano)\.m4a")


class Handler(SimpleHTTPRequestHandler):
    cache = False

    def end_headers(self):
        if not self.cache:
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        self.cache = False
        if self.path.startswith("/stems/"):
            return self.send_stem(body=True)
        super().do_GET()

    def do_HEAD(self):
        self.cache = False
        if self.path.startswith("/stems/"):
            return self.send_stem(body=False)
        super().do_HEAD()

    # 音は途中から読めないと Safari が再生しない（Range 対応）
    def send_stem(self, body):
        m = STEM_PATH.fullmatch(self.path.split("?")[0])
        path = m and os.path.join(STEM_DIR, m.group(1), m.group(2) + ".m4a")
        if not path or not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        start, end = 0, size - 1
        r = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        partial = bool(r and (r.group(1) or r.group(2)))
        if partial:
            if r.group(1):
                start = int(r.group(1))
                end = min(int(r.group(2)), size - 1) if r.group(2) else size - 1
            else:                                   # bytes=-500 ＝ 最後の 500 バイト
                start = max(0, size - int(r.group(2)))
            if start > end:
                self.cache = True
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                return self.end_headers()

        length = end - start + 1
        self.cache = True                           # 分けた音は変わらないので使い回してよい
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "audio/mp4")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not body:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                buf = f.read(min(65536, left))
                if not buf:
                    break
                try:
                    self.wfile.write(buf)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(buf)

    def log_message(self, fmt, *args):
        if self.path.startswith("/stems/"):
            return  # 音は細切れに何度も取りに来るので記録しない
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # iPhone は音を少しずつ取りに来て途中で接続を切る。それは正常なので記録しない
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"YT LOOPER: http://localhost:{PORT}")
        httpd.serve_forever()
