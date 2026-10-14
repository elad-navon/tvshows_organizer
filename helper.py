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

For moves this is entirely optional. The app works fine without it;
turning on "Use local helper for native-speed moves" in the Folders panel
is what makes it call this server instead of the browser's own (slower)
path.

The "Auto Sync" tab, on the other hand, needs it: POST /autosync starts a
job that runs ffsubsync (audio-based subtitle alignment) on every
video/SRT pair at the top level of a folder, and the page polls
GET /autosync/progress for new log lines. Each synced SRT replaces the
original in place; the original is first copied to an _original_subs
subfolder. Requires:  pip install ffsubsync   and   ffmpeg on PATH.

Start with:  python helper.py
   or simply double-click start_helper.bat
Stop with:   close this window, Ctrl+C, or just leave it idle — it shuts
             itself down automatically after IDLE_TIMEOUT_SECONDS with no
             requests from the page (a poll during an active move counts
             as activity, so this never fires mid-transfer).
"""
import importlib.util
import json
import os
import re
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
# Must match HELPER_BASE in app.js. Chosen above this machine's Windows
# dynamic port range (1024-15000) and away from common dev-server ports.
PORT = 47821
# Lets the page tell this helper apart from some other program on the port.
APP_ID = "tv-organizer-helper"
CHUNK_SIZE = 8 * 1024 * 1024  # 8MB
IDLE_TIMEOUT_SECONDS = 120  # > a hidden tab's throttled (~1/min) keepalive ping

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


# ---------------------------------------------------------------------------
# Auto Sync — ffsubsync over a folder
# ---------------------------------------------------------------------------
# Same set as VIDEO_EXT in app.js.
VIDEO_EXT = {".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"}
BACKUP_DIR_NAME = "_original_subs"
# SxxExx or NxNN, not glued to other digits (so "1080p" or "x264" never match).
EPISODE_TAG_RE = re.compile(r"(?<![0-9])(?:S(\d{1,2})E(\d{1,3})|(\d{1,2})x(\d{2}))(?![0-9])", re.I)
# A synced episode whose offset is this far from the run's median gets flagged.
OUTLIER_OFFSET_SECONDS = 10.0


def episode_tag(name):
    m = EPISODE_TAG_RE.search(name)
    if not m:
        return None
    season, episode = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
    return f"S{int(season):02d}E{int(episode):02d}"


def pair_videos_and_subs(names):
    """Match each video file name to its subtitle among `names` (one folder's
    top level). An SRT named after the video (X.srt or X.he.srt) wins;
    otherwise a single unclaimed SRT with the same episode tag is used.
    Returns (pairs, problems): [(video, srt)] and [(video, reason)]."""
    videos = sorted(n for n in names if os.path.splitext(n)[1].lower() in VIDEO_EXT)
    subs = sorted(n for n in names if n.lower().endswith(".srt"))
    matched, problems, used = {}, {}, set()

    for v in videos:
        stem = os.path.splitext(v)[0].lower()
        exact = [s for s in subs if s.lower() in (f"{stem}.srt", f"{stem}.he.srt")]
        if len(exact) == 1:
            matched[v] = exact[0]
            used.add(exact[0])
        elif len(exact) > 1:
            problems[v] = "more than one matching subtitle: " + ", ".join(exact)

    for v in videos:
        if v in matched or v in problems:
            continue
        tag = episode_tag(v)
        if not tag:
            problems[v] = "no matching .srt (and no SxxExx tag in the name to match by)"
            continue
        candidates = [s for s in subs if s not in used and episode_tag(s) == tag]
        if len(candidates) == 1:
            matched[v] = candidates[0]
            used.add(candidates[0])
        elif candidates:
            problems[v] = f"more than one {tag} subtitle: " + ", ".join(candidates)
        else:
            problems[v] = f"no {tag} subtitle found"

    pairs = [(v, matched[v]) for v in videos if v in matched]
    return pairs, [(v, problems[v]) for v in videos if v in problems]


def list_folder(folder):
    return [n for n in os.listdir(folder) if os.path.isfile(os.path.join(folder, n))]


def scan_folder(folder):
    return pair_videos_and_subs(list_folder(folder))


def _registry_path():
    """PATH as currently saved in the registry (Machine + User), so tools
    installed after this helper (or its console) started are still found."""
    try:
        import winreg
    except ImportError:
        return ""
    parts = []
    for root, key in ((winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
                      (winreg.HKEY_CURRENT_USER, "Environment")):
        try:
            with winreg.OpenKey(root, key) as k:
                parts.append(os.path.expandvars(winreg.QueryValueEx(k, "Path")[0]))
        except OSError:
            pass
    return os.pathsep.join(parts)


def _tool_env():
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join(p for p in (_registry_path(), env.get("PATH", "")) if p)
    env["PYTHONIOENCODING"] = "utf-8"
    env["COLUMNS"] = "200"  # keeps ffsubsync's log lines from wrapping
    return env


def _ffsubsync_command(env):
    if importlib.util.find_spec("ffsubsync") is not None:
        return [sys.executable, "-m", "ffsubsync.ffsubsync"]
    exe = shutil.which("ffsubsync", path=env["PATH"])
    return [exe] if exe else None


autosync_jobs = {}  # job_id -> {"log": [...], "done", "total", "synced", "failed", "skipped", "cancel", "proc"}
autosync_lock = threading.Lock()


def _alog(job, level, text):
    with autosync_lock:
        job["log"].append({"time": time.strftime("%H:%M:%S"), "level": level, "text": text})


def _set(job, **fields):
    with autosync_lock:
        job.update(fields)


def _sync_one(job, folder, video, srt, env, cmd):
    """Returns (offset, scale) on success; raises RuntimeError otherwise.
    The original SRT is only touched after ffsubsync produced a result."""
    video_path = os.path.join(folder, video)
    srt_path = os.path.join(folder, srt)
    tmp_dir = tempfile.mkdtemp(prefix="tvorg-autosync-")
    try:
        out_path = os.path.join(tmp_dir, "out.srt")
        # cwd is this script's folder, never the (downloaded) media folder.
        proc = subprocess.Popen(
            cmd + [video_path, "-i", srt_path, "-o", out_path, "--output-encoding", "utf-8"],
            cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _set(job, proc=proc)
        output = proc.communicate()[0].decode("utf-8", errors="replace")
        _set(job, proc=None)
        if job["cancel"]:
            raise RuntimeError("stopped")
        if proc.returncode != 0 or not os.path.isfile(out_path):
            lines = [l.strip() for l in output.splitlines() if l.strip()]
            raise RuntimeError(lines[-1] if lines else f"ffsubsync exited with code {proc.returncode}")

        offset = re.search(r"offset seconds:\s*(-?[\d.]+)", output)
        scale = re.search(r"framerate scale factor:\s*([\d.]+)", output)
        offset = float(offset.group(1)) if offset else None
        scale = float(scale.group(1)) if scale else None

        with open(out_path, "r", encoding="utf-8-sig") as f:
            text = f.read()
        # Keep the very first original: a re-run must not overwrite it.
        backup_dir = os.path.join(folder, BACKUP_DIR_NAME)
        os.makedirs(backup_dir, exist_ok=True)
        backup_path = os.path.join(backup_dir, srt)
        if not os.path.exists(backup_path):
            shutil.copy2(srt_path, backup_path)
        staged = srt_path + ".autosync.tmp"
        with open(staged, "w", encoding="utf-8-sig", newline="") as f:
            f.write(text)
        os.replace(staged, srt_path)
        return offset, scale
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def run_autosync(job, folder):
    run_start = time.monotonic()
    try:
        env = _tool_env()
        cmd = _ffsubsync_command(env)
        if not cmd:
            _alog(job, "err", "ffsubsync is not installed. Run:  pip install ffsubsync   then try again.")
            return
        if not shutil.which("ffmpeg", path=env["PATH"]):
            _alog(job, "err", "ffmpeg was not found. Run:  winget install Gyan.FFmpeg   then try again.")
            return

        pairs, problems = scan_folder(folder)
        _set(job, total=len(pairs), skipped=len(problems))
        _alog(job, "cyan", f"Folder: {folder}")
        _alog(job, "info", f"Found {len(pairs)} episode(s) to sync" + (f", {len(problems)} skipped" if problems else ""))
        for video, reason in problems:
            _alog(job, "warn", f"⚠ Skipped {video} — {reason}")
        if not pairs:
            return

        results = []  # (video, offset, scale)
        for i, (video, srt) in enumerate(pairs, 1):
            if job["cancel"]:
                break
            _alog(job, "cyan", f"[{i}/{len(pairs)}] {video}")
            _alog(job, "dim", f"   subtitle: {srt} — listening to the audio…")
            ep_start = time.monotonic()
            try:
                offset, scale = _sync_one(job, folder, video, srt, env, cmd)
            except (RuntimeError, OSError) as e:
                if job["cancel"]:
                    _alog(job, "warn", "   ⚠ Stopped — this subtitle was left unchanged")
                    break
                with autosync_lock:
                    job["failed"] += 1
                _alog(job, "err", f"   ✗ Failed: {e} — subtitle left unchanged")
                continue
            elapsed = time.monotonic() - ep_start
            with autosync_lock:
                job["synced"] += 1
            results.append((video, offset, scale))
            off_txt = "unknown" if offset is None else f"{offset:+.3f}s"
            scale_txt = "unknown" if scale is None else f"{scale:.3f}"
            _alog(job, "ok", f"   ✓ Synced — offset {off_txt}, framerate ×{scale_txt} ({elapsed:.0f}s)")

        offsets = [o for _, o, _ in results if o is not None]
        median = statistics.median(offsets) if len(offsets) >= 3 else None
        for video, offset, scale in results:
            reasons = []
            if scale is not None and abs(scale - 1) > 0.0005:
                reasons.append(f"framerate ×{scale:.3f}")
            if median is not None and offset is not None and abs(offset - median) > OUTLIER_OFFSET_SECONDS:
                reasons.append(f"offset {offset:+.1f}s vs. typical {median:+.1f}s")
            if reasons:
                _alog(job, "warn", f"⚠ Check manually: {video} ({'; '.join(reasons)})")
    except OSError as e:
        _alog(job, "err", f"✗ {e}")
    finally:
        with autosync_lock:
            stopped = job["cancel"]
            summary = (f"{'Stopped' if stopped else 'Done'}: {job['synced']} synced, "
                       f"{job['failed']} failed, {job['skipped']} skipped "
                       f"in {time.monotonic() - run_start:.0f}s.")
        if job["total"] or job["skipped"]:
            _alog(job, "warn" if (stopped or job["failed"]) else "ok", summary)
        _set(job, done=True, proc=None)


def start_autosync(folder):
    """Returns (job_id, None) or (None, (http_status, error))."""
    with autosync_lock:
        if any(not j["done"] for j in autosync_jobs.values()):
            return None, (409, "a sync is already running")
        for job_id in [k for k, j in autosync_jobs.items() if j["done"]]:
            del autosync_jobs[job_id]
        job_id = uuid.uuid4().hex
        job = {"log": [], "done": False, "total": 0, "synced": 0, "failed": 0,
               "skipped": 0, "cancel": False, "proc": None}
        autosync_jobs[job_id] = job
    threading.Thread(target=run_autosync, args=(job, folder), daemon=True).start()
    return job_id, None


def cancel_autosync(job_id):
    with autosync_lock:
        job = autosync_jobs.get(job_id)
        if not job:
            return False
        job["cancel"] = True
        proc = job["proc"]
    if proc and proc.poll() is None:
        if os.name == "nt":
            # /T also ends the ffmpeg process ffsubsync started.
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
        else:
            proc.kill()
    return True


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
            self._send_json(200, {"ok": True, "app": APP_ID})
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
        if parsed.path == "/autosync/progress":
            query = parse_qs(parsed.query)
            job_id = query.get("job", [""])[0]
            try:
                since = max(0, int(query.get("since", ["0"])[0]))
            except ValueError:
                since = 0
            with autosync_lock:
                job = autosync_jobs.get(job_id)
                if job is not None:
                    payload = {k: job[k] for k in ("done", "total", "synced", "failed", "skipped")}
                    payload["log"] = job["log"][since:]
                    payload["next"] = len(job["log"])
            if job is None:
                self._send_json(404, {"ok": False, "error": "unknown job"})
                return
            self._send_json(200, {"ok": True, **payload})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        _touch()
        if self.path not in ("/move", "/autosync", "/autosync/scan", "/autosync/cancel"):
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "malformed request body"})
            return

        if self.path in ("/autosync", "/autosync/scan"):
            folder = str(data.get("folder", "")).strip().strip('"')
            if not folder or not os.path.isdir(folder):
                self._send_json(404, {"ok": False, "error": f"folder not found: {folder}"})
                return
            if self.path == "/autosync/scan":
                try:
                    names = list_folder(folder)
                except OSError as e:
                    self._send_json(500, {"ok": False, "error": str(e)})
                    return
                pairs, problems = pair_videos_and_subs(names)
                self._send_json(200, {
                    "ok": True,
                    "videoCount": sum(os.path.splitext(n)[1].lower() in VIDEO_EXT for n in names),
                    "subtitleCount": sum(n.lower().endswith(".srt") for n in names),
                    "pairs": [{"video": v, "srt": s} for v, s in pairs],
                    "skipped": [{"video": v, "reason": r} for v, r in problems],
                })
                return
            job_id, err = start_autosync(folder)
            if err:
                self._send_json(err[0], {"ok": False, "error": err[1]})
                return
            self._send_json(200, {"ok": True, "job": job_id})
            return
        if self.path == "/autosync/cancel":
            if cancel_autosync(str(data.get("job", ""))):
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"ok": False, "error": "unknown job"})
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


class HelperServer(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR (Python's default for HTTP servers) lets a
    # second program bind the same port silently, and requests then go to
    # whichever one Windows picks. Claim the port exclusively instead, so a
    # conflict fails loudly at startup.
    allow_reuse_address = not hasattr(socket, "SO_EXCLUSIVEADDRUSE")

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    try:
        server = HelperServer((HOST, PORT), Handler)
    except OSError as e:
        # The OS message can be localized, so it isn't printed (it may not
        # be encodable on the console's codepage); the error number is enough.
        code = getattr(e, "winerror", None) or e.errno
        print(f"Could not start: port {PORT} is already in use by another program (error {code}).")
        print("Close that program and run start_helper.bat again.")
        sys.exit(1)
    print(f"TV Organizer helper listening on http://{HOST}:{PORT} (this machine only)")
    print(f"Shuts down automatically after {IDLE_TIMEOUT_SECONDS}s of inactivity, or press Ctrl+C to stop now.")
    threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
