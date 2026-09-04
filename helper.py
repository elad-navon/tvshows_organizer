"""
TV Organizer — local move helper.

The browser app normally moves files through the File System Access API,
which stages every write through a temporary swap file before it can
finalize it — slow for large video files, especially on a network drive
or with antivirus scanning the new file. This script runs a tiny HTTP
server on 127.0.0.1 only (nothing outside this machine can reach it) so
the page can ask it to move a file with a native OS rename/copy instead
— the same thing "move" in CMD does, and just as fast.

This is entirely optional. The app works fine without it; turning on
"Use local helper for native-speed moves" in the Folders panel is what
makes it call this server instead of the browser's own (slower) path.

Start with:  python helper.py
   or simply double-click start_helper.bat
Stop with:   close this window, or Ctrl+C.
"""
import json
import os
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765

# Only these origins are ever allowed to see a response from this server —
# the app opened as a local file, from GitHub Pages, or from itself. A page
# opened as a local file (file://...) is a browser fetch's "null" origin,
# not the literal string "file://" — both are accepted here.
ALLOWED_ORIGINS = ("null",)
ALLOWED_ORIGIN_PREFIXES = (
    "https://elad-navon.github.io",
    "http://127.0.0.1",
    "http://localhost",
)


class Handler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS or origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/ping":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/move":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "malformed request body"})
            return

        src = data.get("src", "")
        dest = data.get("dest", "")
        if not src or not dest:
            self._send_json(400, {"ok": False, "error": "src and dest are required"})
            return
        if not os.path.isfile(src):
            self._send_json(404, {"ok": False, "error": f"source file not found: {src}"})
            return
        if os.path.exists(dest):
            self._send_json(409, {"ok": False, "error": f"destination already exists: {dest}"})
            return

        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(src, dest)
            self._send_json(200, {"ok": True})
        except OSError as e:
            self._send_json(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[helper] {self.address_string()} - {fmt % args}")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"TV Organizer helper listening on http://{HOST}:{PORT} (this machine only)")
    print("Keep this window open while using the app. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
