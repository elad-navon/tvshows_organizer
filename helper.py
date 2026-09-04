"""
TV Organizer — local move helper.

The browser app normally moves files through the File System Access API,
which stages every write through a temporary swap file before it can
finalize it — slow for large video files, especially on a network drive
or with antivirus scanning the new file. This script runs a tiny HTTP
server on 127.0.0.1 only (nothing outside this machine can reach it) so
the page can ask it to move a file with a native OS rename/copy instead
— the same thing "move" in CMD does, and just as fast.

A move is started with POST /move, which returns immediately with a job
id and runs the actual work in a background thread; the browser polls
GET /progress?job=<id> a few times a second to drive its progress bar.
When source and destination are on the same drive this finishes on the
very first poll (a rename is a metadata-only operation, not a copy) —
across drives it streams the file in chunks so real progress is reported.

This is entirely optional. The app works fine without it; turning on
"Use local helper for native-speed moves" in the Folders panel is what
makes it call this server instead of the browser's own (slower) path.

Start with:  python helper.py
   or simply double-click start_helper.bat
Stop with:   close this window, Ctrl+C, or just leave it idle — it shuts
             itself down automatically after IDLE_TIMEOUT_SECONDS with no
             requests from the page (a poll during an active move counts
             as activity, so this never fires mid-transfer).
"""
import json
import os
import shutil
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
PORT = 8765
CHUNK_SIZE = 8 * 1024 * 1024  # 8MB
IDLE_TIMEOUT_SECONDS = 60

_last_activity = time.monotonic()
_activity_lock = threading.Lock()


def _touch():
    global _last_activity
    with _activity_lock:
        _last_activity = time.monotonic()


def _idle_watchdog(server):
    while True:
        time.sleep(5)
        with _activity_lock:
            idle_for = time.monotonic() - _last_activity
        if idle_for >= IDLE_TIMEOUT_SECONDS:
            print(f"\nNo activity for {IDLE_TIMEOUT_SECONDS}s - shutting down.")
            server.shutdown()
            return

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

jobs = {}  # job_id -> {"copied": int, "total": int, "done": bool, "error": str|None}
jobs_lock = threading.Lock()


def run_move(job_id, src, dest):
    try:
        total = os.path.getsize(src)
        with jobs_lock:
            jobs[job_id]["total"] = total

        try:
            # Same drive: a metadata-only rename, effectively instant —
            # no chunk loop, nothing meaningful to report progress on.
            os.rename(src, dest)
            with jobs_lock:
                jobs[job_id]["copied"] = total
                jobs[job_id]["done"] = True
            return
        except OSError:
            pass  # different drives (or some other rename failure) — stream-copy below

        copied = 0
        with open(src, "rb") as fsrc, open(dest, "wb") as fdst:
            while True:
                buf = fsrc.read(CHUNK_SIZE)
                if not buf:
                    break
                fdst.write(buf)
                copied += len(buf)
                with jobs_lock:
                    jobs[job_id]["copied"] = copied
        shutil.copystat(src, dest)
        os.remove(src)
        with jobs_lock:
            jobs[job_id]["done"] = True
    except OSError as e:
        with jobs_lock:
            jobs[job_id]["error"] = str(e)
            jobs[job_id]["done"] = True


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
        _touch()
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        _touch()
        parsed = urlparse(self.path)
        if parsed.path == "/ping":
            self._send_json(200, {"ok": True})
            return
        if parsed.path == "/progress":
            job_id = parse_qs(parsed.query).get("job", [""])[0]
            with jobs_lock:
                job = jobs.get(job_id)
                job = dict(job) if job else None
            if job is None:
                self._send_json(404, {"ok": False, "error": "unknown job"})
                return
            self._send_json(200, {"ok": True, **job})
            if job["done"]:
                with jobs_lock:
                    jobs.pop(job_id, None)
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        _touch()
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
        except OSError as e:
            self._send_json(500, {"ok": False, "error": str(e)})
            return

        job_id = uuid.uuid4().hex
        with jobs_lock:
            jobs[job_id] = {"copied": 0, "total": 0, "done": False, "error": None}
        threading.Thread(target=run_move, args=(job_id, src, dest), daemon=True).start()
        self._send_json(200, {"ok": True, "job": job_id})

    def log_message(self, fmt, *args):
        print(f"[helper] {self.address_string()} - {fmt % args}")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"TV Organizer helper listening on http://{HOST}:{PORT} (this machine only)")
    print(f"Shuts down automatically after {IDLE_TIMEOUT_SECONDS}s of inactivity, or press Ctrl+C to stop now.")
    threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
