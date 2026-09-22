"""Dev server for the viewer: serves docs/ with caching off, and accepts screenshots.

    python dev/serve.py            # port from $PORT (launch.json "autoPort": true), else 5590
    python dev/serve.py 5592       # an explicit port still works

`python -m http.server <port>` takes the port as a positional argument, so a launch.json entry
using it has to hardcode one -- and then the preview refuses to start whenever that port is
already taken (which it is, every time a server is already running from an earlier session).
PORT from the environment comes first for that reason.

THREADED, and it has to be. A single-threaded socketserver.TCPServer serves one connection at a
time with a listen backlog of 5, and the viewer opens dozens of module/texture requests at once:
on Windows the overflow is refused outright (net::ERR_CONNECTION_REFUSED on render/*.js), so the
page never mounted.

POST /shot?run=<run>&name=<name> with a PNG data URL (or raw base64) as the body writes
dev/shots/<run>/<name>.png. The page's __view.shot() and __view.sweep() (index.html) use it so
before/after renders can be diffed offline. Nothing under dev/ is published; docs/ is what GitHub
Pages serves.
"""
import base64
import http.server
import json
import os
import re
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, "..", "docs"))
SHOTS = os.path.join(HERE, "shots")
PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 5590))
SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DOCS, **k)

    def end_headers(self):
        # the viewer is edited live and reloaded constantly; a cached ES module is the difference
        # between testing the change and testing the previous one
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path != "/shot":
            self.send_error(404)
            return
        run = q.get("run", ["default"])[0]
        name = q.get("name", ["shot"])[0]
        if not (SAFE.match(run) and SAFE.match(name)):
            self.send_error(400, "bad run/name")
            return
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        if body.startswith(b"data:"):
            body = body.split(b",", 1)[1]
        try:
            png = base64.b64decode(body)
        except Exception:
            self.send_error(400, "not base64")
            return
        folder = os.path.join(SHOTS, run)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name + ".png")
        with open(path, "wb") as f:
            f.write(png)
        out = json.dumps({"saved": path, "bytes": len(png)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):
        if "/shot" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    os.makedirs(SHOTS, exist_ok=True)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("serving %s on http://localhost:%d/  (shots -> %s)" % (DOCS, PORT, SHOTS), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
