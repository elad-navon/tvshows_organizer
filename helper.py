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
import hashlib
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


SRT_TIMING_RE = re.compile(r"^\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})(.*)$")
MIN_CUE_MS = 800  # an overlap is fixed by shortening the earlier cue only down to this
CUE_GAP_MS = 40


def decode_srt(raw):
    """Hebrew SRTs are often Windows-1255 rather than UTF-8."""
    for encoding in ("utf-8-sig", "cp1255"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1")


def parse_srt(text):
    """[{start, end, rest, text}] in ms, or None if there are no cues (then
    the file is left exactly as ffsubsync wrote it). A block without a
    timing line — a cue text with an empty line in it, or a stray fragment
    such as a cut-off "i>" at the end — goes onto the cue before it."""
    cues = []
    for block in re.split(r"\r?\n[ \t]*\r?\n", text.strip()):
        lines = block.splitlines()
        timing = next((i for i, l in enumerate(lines[:2]) if SRT_TIMING_RE.match(l)), None)
        if timing is None:
            if cues and block.strip():
                cues[-1]["text"] += "\n" + "\n".join(l.strip() for l in lines if l.strip())
            continue
        g = SRT_TIMING_RE.match(lines[timing]).groups()
        ms = lambda h, m, s, f: ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(f)
        cues.append({"start": ms(*g[0:4]), "end": ms(*g[4:8]), "rest": g[8].rstrip(),
                     "text": "\n".join(l.strip() for l in lines[timing + 1:])})
    return cues or None


def format_srt(cues):
    def ts(ms):
        ms = max(0, ms)
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    text = "\n".join(f"{i}\n{ts(c['start'])} --> {ts(c['end'])}{c['rest']}\n{c['text']}\n"
                     for i, c in enumerate(cues, 1))
    return text.replace("\n", "\r\n")


def tidy_synced_cues(source, synced):
    """ffsubsync sorts its output by start time, so where the offset jumps
    between two sections by more than the gap between two cues, they swap
    places and overlap. Puts the cues back in the source's order (matched
    by text), then removes every overlap: the two cues move apart into the
    free time after the later one and before the earlier one, keeping their
    length; only when that isn't enough is the earlier cue shortened (while
    it stays readable) and the later one pushed after what's left.
    Before that, a misplaced "island" section is put back (see
    _fix_offset_islands). Returns (cues, overlaps fixed, islands fixed)."""
    unused = {}
    for i, c in enumerate(source):
        unused.setdefault(c["text"], []).append(i)
    order = []
    for c in synced:
        if not unused.get(c["text"]):
            order = None  # text changed somewhere; keep ffsubsync's order
            break
        order.append(unused[c["text"]].pop(0))
    islands = 0
    if order:
        pairs = sorted(zip(order, synced), key=lambda p: p[0])
        cues = [dict(c) for _, c in pairs]
        shifts = [c["start"] - source[i]["start"] for i, c in pairs]
        islands = _fix_offset_islands(cues, shifts)
        src_of = [i for i, _ in pairs]
        _snap_section_bounds(source, src_of, cues, shifts)
    else:
        cues = [dict(c) for c in synced]
        src_of = None

    fixed = 0
    for i in range(len(cues) - 1):
        prev, cur = cues[i], cues[i + 1]
        if cur["start"] >= prev["end"]:
            continue
        if src_of:
            # Two people talking at once: the translator's own overlap stays.
            was = source[src_of[i]]["end"] - source[src_of[i + 1]]["start"]
            if was > 0 and prev["end"] - cur["start"] <= was + 100:
                continue
        fixed += 1
        needed = prev["end"] + CUE_GAP_MS - cur["start"]
        room_after = cues[i + 2]["start"] - CUE_GAP_MS - cur["end"] if i + 2 < len(cues) else needed
        room_before = prev["start"] - (cues[i - 1]["end"] + CUE_GAP_MS if i > 0 else 0)
        later = max(0, min(needed, room_after))
        earlier = max(0, min(needed - later, room_before))
        if later + earlier >= needed:
            # Both keep their full length: the later cue moves into the free
            # time after it, the earlier one into the free time before it.
            cur["start"] += later
            cur["end"] += later
            prev["start"] -= earlier
            prev["end"] -= earlier
            continue
        prev["end"] = min(prev["end"], max(prev["start"] + MIN_CUE_MS, cur["start"] - CUE_GAP_MS))
        if cur["start"] < prev["end"] + CUE_GAP_MS:
            shift = prev["end"] + CUE_GAP_MS - cur["start"]
            cur["start"] += shift
            cur["end"] += shift
    return cues, fixed, islands


ISLAND_JUMP_MS = 5000
ISLAND_CONTEXT = 10  # cues on each side an island is compared with


def _fix_offset_islands(cues, shifts):
    """Split alignment sometimes gives a stretch of cues an offset far from
    both its neighbours (e.g. two minutes moved 55s back while the sections
    around it are within a second or two of each other). A real cut changes
    the offset for good; an offset that jumps away and comes back is a
    misdetection, which drops those lines into another scene. Such an
    island gets the offset of the cues just before it. `cues` (in source
    order) and `shifts` (each cue's synced minus original start) are
    updated in place. Returns the number of islands fixed."""
    def median(values):
        return sorted(values)[len(values) // 2]

    blocks = []  # [first, last] cue indices of runs with no jump > ISLAND_JUMP_MS
    for i in range(len(shifts)):
        if blocks and abs(shifts[i] - shifts[i - 1]) <= ISLAND_JUMP_MS:
            blocks[-1][1] = i
        else:
            blocks.append([i, i])
    fixed = 0
    for k in range(1, len(blocks) - 1):
        first, last = blocks[k]
        # The cues right next to the island — a whole neighbouring block
        # can span several legitimate offset changes.
        prev = median(shifts[max(blocks[k - 1][0], first - ISLAND_CONTEXT):first])
        nxt = median(shifts[last + 1:min(blocks[k + 1][1] + 1, last + 1 + ISLAND_CONTEXT)])
        own = median(shifts[first:last + 1])
        if (abs(own - prev) > ISLAND_JUMP_MS and abs(own - nxt) > ISLAND_JUMP_MS
                and abs(prev - nxt) <= ISLAND_JUMP_MS and last - first + 1 < len(cues) // 3):
            target = shifts[first - 1]
            for i in range(first, last + 1):
                delta = target - shifts[i]
                cues[i]["start"] += delta
                cues[i]["end"] += delta
                shifts[i] = target
            fixed += 1
    return fixed


SECTION_STEP_MS = 1000     # a smoothed offset change bigger than this is a section boundary
SNAP_WINDOW_MS = 180000    # how far from ffsubsync's boundary the real one is looked for
def is_break_marker(text):
    """A translator's ad-break mark: a cue of only a few "+", "*" or "#"
    (sometimes in italics, e.g. "<i>+++</i>")."""
    plain = re.sub(r"<[^>]*>", "", text).strip()
    return bool(plain) and len(plain) <= 5 and set(plain) <= set("+*#")


def _snap_section_bounds(source, src_idx, cues, shifts):
    """ffsubsync finds the offset change at an ad break but often places it
    a few cues — even minutes — off, so the cues in between get the wrong
    section's offset. The real boundary is a gap in the source at least as
    long as the time the cut removed: preferably one holding a break marker
    (translators often leave a lone "+" cue there, which ffsubsync drops),
    otherwise the qualifying gap nearest ffsubsync's boundary. `cues` and
    `shifts` follow source order (src_idx); updated in place. Returns the
    number of boundaries moved."""
    def median(values):
        return sorted(values)[len(values) // 2]

    n = len(cues)
    smooth = [median(shifts[max(0, j - 5):j + 6]) for j in range(n)]
    points = []
    for j in range(1, n):
        if abs(smooth[j] - smooth[j - 1]) > SECTION_STEP_MS and (not points or j - points[-1] > 5):
            points.append(j)

    moved = 0
    for k, cp in enumerate(points):
        lo = points[k - 1] + 1 if k else 1
        hi = points[k + 1] - 1 if k + 1 < len(points) else n - 1
        left = median(shifts[max(lo - 1, cp - 10):cp])
        right = median(shifts[cp:min(hi + 1, cp + 10)])
        need = abs(right - left) - 300
        at = source[src_idx[cp]]["start"]
        best = None  # (no marker, distance, boundary index)
        for b in range(lo, hi + 1):
            before, after = source[src_idx[b - 1]], source[src_idx[b]]
            if abs(after["start"] - at) > SNAP_WINDOW_MS or after["start"] - before["end"] < need:
                continue
            marker = any(is_break_marker(source[m]["text"]) for m in range(src_idx[b - 1] + 1, src_idx[b]))
            key = (not marker, abs(b - cp), b)
            best = min(best, key) if best else key
        if not best or best[2] == cp:
            continue
        b = best[2]
        target, span = (right, range(b, cp)) if b < cp else (left, range(cp, b))
        for i in span:
            delta = target - shifts[i]
            cues[i]["start"] += delta
            cues[i]["end"] += delta
            shifts[i] = target
        moved += 1
    return moved


TEXT_SUB_CODECS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}


def choose_reference(streams):
    """Picks what to align against, from ffprobe's stream list. Returns
    (--reference-stream value or None for ffsubsync's default, description).
    An embedded English text subtitle is the most precise reference; the
    English audio comes next — a dubbed track (often the default in
    foreign releases) has different pauses and misleads the alignment."""
    subs = [s for s in streams if s.get("codec_type") == "subtitle"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    lang = lambda s: (s.get("tags") or {}).get("language", "").lower()
    for i, s in enumerate(subs):
        forced = (s.get("disposition") or {}).get("forced") or "forced" in (s.get("tags") or {}).get("title", "").lower()
        if s.get("codec_name") in TEXT_SUB_CODECS and lang(s) in ("eng", "en") and not forced:
            return f"s:{i}", "the embedded English subtitles"
    for i, s in enumerate(audios):
        if lang(s) in ("eng", "en"):
            return f"a:{i}", "the English audio"
    return None, "the audio"


def _pick_reference(video_path, env):
    ffprobe = shutil.which("ffprobe", path=env["PATH"])
    if not ffprobe:
        return choose_reference([])
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "stream=codec_type,codec_name:stream_tags=language,title:stream_disposition=forced",
             "-of", "json", video_path],
            capture_output=True, env=env, timeout=60,
            cwd=os.path.dirname(os.path.abspath(__file__)),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        streams = json.loads(out.stdout or b"{}").get("streams", [])
    except (OSError, subprocess.SubprocessError, ValueError):
        streams = []
    return choose_reference(streams)


MIN_CHUNK_CUES = 8               # fewer lines than this can't be aligned reliably on their own
CHUNK_MAX_OFFSET_SECONDS = 30   # search range for the first part
CHUNK_LOCAL_SECONDS = 6         # search range around the previous part's offset
CHUNK_FIRST_SECONDS = 10        # search range for the first part around the whole subtitle's offset
CHUNK_CENTERED_SECONDS = 3      # search range around a part's own estimate
CENTER_MAX_DEVIATION_MS = 15000 # how far a part's estimate may be from the whole subtitle's offset


def _run_process(job, argv, env):
    """Runs a tool (stoppable from the page); returns its output, raises
    RuntimeError if it fails."""
    # cwd is this script's folder, never the (downloaded) media folder.
    proc = subprocess.Popen(
        argv, cwd=os.path.dirname(os.path.abspath(__file__)), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    _set(job, proc=proc)
    output = proc.communicate()[0].decode("utf-8", errors="replace")
    _set(job, proc=None)
    if job["cancel"]:
        raise RuntimeError("stopped")
    if proc.returncode != 0:
        lines = [l.strip() for l in output.splitlines() if l.strip()]
        raise RuntimeError(lines[-1] if lines else f"{os.path.basename(argv[0])} exited with code {proc.returncode}")
    return output


def _sync_split(job, cmd, env, video_path, reference, source_path, tmp_dir):
    """ffsubsync's piecewise alignment over the whole episode. Returns
    (text, offset, scale, segments)."""
    out_path = os.path.join(tmp_dir, "out.srt")
    # --split-penalty lets the offset change along the episode (a subtitle
    # made for a cut with different ad breaks or scenes drifts by a few
    # seconds at each one); a single global offset can't fix that.
    args = [video_path, "-i", source_path, "-o", out_path, "--output-encoding", "utf-8"]
    if reference:
        args += ["--reference-stream", reference]
    output = _run_process(job, cmd + args + ["--split-penalty"], env)
    if not os.path.isfile(out_path):
        raise RuntimeError("ffsubsync wrote no output")
    offset = re.search(r"offset seconds:\s*(-?[\d.]+)", output)
    scale = re.search(r"framerate scale factor:\s*([\d.]+)", output)
    segments = re.search(r"split alignment:\s*(\d+) segment", output)
    with open(out_path, "r", encoding="utf-8-sig") as f:
        text = f.read()
    return (text, float(offset.group(1)) if offset else None, float(scale.group(1)) if scale else None,
            int(segments.group(1)) if segments else 1)


def break_chunks(cues):
    """The source's lines split at the translator's lone ad-break marks
    (dropped). None unless that gives at least two parts."""
    chunks, current = [], []
    for c in cues:
        if is_break_marker(c["text"]):
            if current:
                chunks.append(current)
                current = []
        else:
            current.append(c)
    if current:
        chunks.append(current)
    return chunks if len(chunks) >= 2 else None


INFER_SMOOTH = 15             # cues on each side of the median that finds the steady offsets
INFER_MIN_PART = 30           # fewest cues between two inferred breaks
INFER_GAP_WINDOW_MS = 60000   # how far from the step the break's gap is looked for


def infer_break_chunks(source, synced):
    """Without the translator's marks, ffsubsync's piecewise result still
    shows roughly where the offset steps at each ad break, though around
    them it is often noisy (cues thrown tens of seconds away). A wide
    median keeps only the steady offsets; each step becomes a break placed
    in the longest gap of the source near it. Returns (the source's lines
    split there, like break_chunks; each part's median offset in ms), or
    None."""
    unused = {}
    for i, c in enumerate(source):
        unused.setdefault(c["text"], []).append(i)
    pairs = []
    for c in synced:
        if not unused.get(c["text"]):
            return None
        pairs.append((unused[c["text"]].pop(0), c["start"]))
    pairs.sort()
    n = len(pairs)
    if n < 2 * INFER_MIN_PART:
        return None
    shifts = [start - source[i]["start"] for i, start in pairs]
    def median_around(j):
        window = sorted(shifts[max(0, j - INFER_SMOOTH):j + INFER_SMOOTH + 1])
        return window[len(window) // 2]
    smooth = [median_around(j) for j in range(n)]
    steps = []
    for j in range(INFER_MIN_PART, n - INFER_MIN_PART + 1):
        if abs(smooth[j] - smooth[j - 1]) > SECTION_STEP_MS and (not steps or j - steps[-1] >= INFER_MIN_PART):
            steps.append(j)

    cuts = []  # source indices a new part starts at
    for j in steps:
        at = source[pairs[j][0]]["start"]
        best = None
        for b in range(max(1, j - INFER_MIN_PART), min(n, j + INFER_MIN_PART)):
            after, before = source[pairs[b][0]], source[pairs[b - 1][0]]
            if abs(after["start"] - at) <= INFER_GAP_WINDOW_MS:
                gap = after["start"] - before["end"]
                best = max(best, (gap, -abs(b - j), b)) if best else (gap, -abs(b - j), b)
        cut = pairs[best[2]][0]
        if not cuts or cut > cuts[-1]:
            cuts.append(cut)
    if not cuts:
        return None
    bounds = [0] + cuts + [len(source)]
    chunks, centers = [], []
    for a, b in zip(bounds, bounds[1:]):
        chunk = [c for c in source[a:b] if not is_break_marker(c["text"])]
        own = sorted(shifts[k] for k, (i, _) in enumerate(pairs) if a <= i < b)
        if chunk and own:
            chunks.append(chunk)
            centers.append(own[len(own) // 2])  # the median ignores the noisy cues
    if len(chunks) < 2:
        return None
    # A short part where ffsubsync was mostly noise (often the first or last
    # minutes: S01E07 -57s, S01E04 -41s) gets a median far from its
    # neighbours; it takes the neighbour's estimate instead.
    for k in range(len(centers)):
        near = [centers[j] for j in (k - 1, k + 1) if 0 <= j < len(centers)]
        if all(abs(centers[k] - n) > ISLAND_JUMP_MS for n in near):
            centers[k] = near[0]
    return chunks, centers


def _prepare_reference(job, cmd, env, video_path, reference, tmp_dir):
    """Extracts what the parts are aligned against, once per episode, into
    tmp_dir (never next to the video): the English subtitle track, or the
    audio track analysed into speech (ffsubsync --serialize-speech), so
    each later alignment takes about a second. Returns its path."""
    stream = reference or "a:0"
    ffmpeg = shutil.which("ffmpeg", path=env["PATH"])
    if stream.startswith("s:"):
        ref_path = os.path.join(tmp_dir, "ref.srt")
        _run_process(job, [ffmpeg, "-v", "error", "-y", "-i", video_path, "-map", f"0:{stream}", ref_path], env)
        return ref_path
    wav_path = os.path.join(tmp_dir, "ref.wav")
    _run_process(job, [ffmpeg, "-v", "error", "-y", "-i", video_path, "-map", f"0:{stream}",
                       "-ac", "1", "-ar", "16000", wav_path], env)
    _run_process(job, cmd + [wav_path, "--serialize-speech"], env)
    return os.path.join(tmp_dir, "ref.npz")


def _align_part(job, cmd, env, ref_path, tmp_dir, tag, cues, pre_ms, window_s):
    """One offset (ms) for `cues`, searched within window_s of pre_ms, or None."""
    part_in = os.path.join(tmp_dir, f"part-{tag}.srt")
    with open(part_in, "w", encoding="utf-8", newline="") as f:
        f.write(format_srt([dict(c, start=c["start"] + pre_ms, end=c["end"] + pre_ms) for c in cues]))
    output = _run_process(job, cmd + [ref_path, "-i", part_in, "-o", part_in + ".out",
                                      "--output-encoding", "utf-8", "--no-fix-framerate",
                                      "--max-offset-seconds", str(window_s)], env)
    m = re.search(r"offset seconds:\s*(-?[\d.]+)", output)
    return pre_ms + round(float(m.group(1)) * 1000) if m else None


STEADY_PROBES = 6             # equal parts the steadiness check measures separately
STEADY_AGREE = 5              # how many of them must agree for a single offset
STEADY_TOLERANCE_MS = 700


def _steady_offset(job, cmd, env, ref_path, tmp_dir, cues):
    """Many subtitles were made for the very same cut as the video and only
    need one offset; piecewise alignment then invents sections anyway
    (S02E18: 200 lines moved, S02E14: the closing minutes thrown 39s away).
    The whole subtitle's offset is checked against STEADY_PROBES equal parts
    measured on their own: if nearly all agree, that offset is returned for
    everything; otherwise None."""
    whole = _align_part(job, cmd, env, ref_path, tmp_dir, "whole", cues, 0, CHUNK_MAX_OFFSET_SECONDS)
    if whole is None or len(cues) < STEADY_PROBES * MIN_CHUNK_CUES:
        return None
    n = len(cues)
    agree = 0
    for k in range(STEADY_PROBES):
        part = cues[k * n // STEADY_PROBES:(k + 1) * n // STEADY_PROBES]
        found = _align_part(job, cmd, env, ref_path, tmp_dir, f"probe{k}", part, 0, CHUNK_MAX_OFFSET_SECONDS)
        agree += found is not None and abs(found - whole) <= STEADY_TOLERANCE_MS
    return whole if agree >= STEADY_AGREE else None


def _sync_by_breaks(job, cmd, env, ref_path, chunks, tmp_dir, centers=None):
    """When the translator marked the ad breaks, they are where the offset
    changes — more reliable than ffsubsync guessing the boundaries (it
    misses some and invents others). Each part between two marks is aligned
    on its own with a single offset, against the reference prepared by
    _prepare_reference. A part too short to align takes the offset of the
    part before it. `centers` (ms per part) are estimates to search narrowly
    around, e.g. from ffsubsync's piecewise result. Returns (text, offset of
    the first part, scale)."""
    def align(k, chunk, pre_ms, window_s):
        return _align_part(job, cmd, env, ref_path, tmp_dir, k, chunk, pre_ms, window_s)

    def at_edge(found, center, window_s):
        return found is None or abs(found - center) > (window_s - 0.5) * 1000

    # A part searched widely can lock onto similar speech far away (S01E11
    # part 5: +29s instead of -5.4s; S01E07 part 1: +22s instead of +1.8s),
    # so every search is narrow around an estimate:
    # - given centers: the part's own estimate; a result at the edge keeps it;
    # - otherwise the first part searches around the whole subtitle's single
    #   offset (all lines together lock reliably), and each next part around
    #   the part before it, since a break changes the offset by a few seconds.
    #   Only a result at the edge of that (an unusually long cut) falls back
    #   to a wide search.
    offsets, prev = [], None
    whole = align("all", [c for chunk in chunks for c in chunk], 0, CHUNK_MAX_OFFSET_SECONDS)
    if centers is None:
        prev = whole
        first_window = CHUNK_FIRST_SECONDS
    elif whole is not None:
        # Neighbouring parts can be noisy the same way (S01E04: the first two
        # both +24s); every part stays within a few breaks of the whole
        # subtitle's offset, so an estimate further out takes the nearest
        # sound one.
        sound = [abs(c - whole) <= CENTER_MAX_DEVIATION_MS for c in centers]
        if any(sound):
            centers = [c if ok else centers[min((j for j in range(len(centers)) if sound[j]), key=lambda j: abs(j - k))]
                       for k, (c, ok) in enumerate(zip(centers, sound))]
    for k, chunk in enumerate(chunks):
        if len(chunk) < MIN_CHUNK_CUES:
            offsets.append(None)
            continue
        if centers is not None:
            found = align(k, chunk, centers[k], CHUNK_CENTERED_SECONDS)
            if at_edge(found, centers[k], CHUNK_CENTERED_SECONDS):
                found = centers[k]
        else:
            window = first_window if not offsets or all(o is None for o in offsets) else CHUNK_LOCAL_SECONDS
            found = align(k, chunk, prev or 0, window) if prev is not None else None
            if at_edge(found, prev or 0, window):
                found = align(k, chunk, 0, CHUNK_MAX_OFFSET_SECONDS)
        offsets.append(found)
        prev = found if found is not None else prev
    known = [o for o in offsets if o is not None]
    if not known:
        raise RuntimeError("none of the parts between the ad breaks could be aligned")

    cues, current = [], known[0]
    for chunk, o in zip(chunks, offsets):
        current = o if o is not None else current
        cues += [dict(c, start=c["start"] + current, end=c["end"] + current) for c in chunk]
    return format_srt(cues), known[0] / 1000, 1.0


def _file_digest(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


def _sync_one(job, folder, video, srt, env, cmd, reference):
    """Returns (offset, scale, segments) on success; raises RuntimeError
    otherwise. The original SRT is only touched after ffsubsync produced a
    result."""
    video_path = os.path.join(folder, video)
    srt_path = os.path.join(folder, srt)
    backup_dir = os.path.join(folder, BACKUP_DIR_NAME)
    backup_path = os.path.join(backup_dir, srt)
    # Remembers what the last run wrote, so a re-run can tell its own output
    # (start again from the original) from a newly downloaded subtitle.
    marker_path = backup_path + ".synced-sha1"
    source_path = srt_path
    if os.path.isfile(backup_path) and os.path.isfile(marker_path):
        with open(marker_path, encoding="ascii") as f:
            if f.read().strip() == _file_digest(srt_path):
                source_path = backup_path
    tmp_dir = tempfile.mkdtemp(prefix="tvorg-autosync-")
    try:
        with open(source_path, "rb") as f:
            source = parse_srt(decode_srt(f.read()))
        ref_path = _prepare_reference(job, cmd, env, video_path, reference, tmp_dir) if source else None
        lines = [c for c in source if not is_break_marker(c["text"])] if source else []
        steady = _steady_offset(job, cmd, env, ref_path, tmp_dir, lines) if lines else None
        chunks = centers = None
        if steady is not None:
            mode = "single"
            text = format_srt([dict(c, start=c["start"] + steady, end=c["end"] + steady) for c in lines])
            offset, scale, segments = steady / 1000, 1.0, 1
        else:
            chunks = break_chunks(source) if source else None
            mode = "marks" if chunks else "split"
            if not chunks:
                text, offset, scale, segments = _sync_split(job, cmd, env, video_path, reference, source_path, tmp_dir)
                split_cues = parse_srt(text)
                inferred = infer_break_chunks(source, split_cues) if source and split_cues else None
                if inferred:
                    chunks, centers = inferred
                    mode = "inferred"
            if chunks:
                text, offset, scale = _sync_by_breaks(job, cmd, env, ref_path, chunks, tmp_dir, centers)
                segments = len(chunks)
        overlaps = islands = 0
        synced = parse_srt(text)
        if synced is not None:
            cues, overlaps, islands = tidy_synced_cues(source or [], synced)
            text = format_srt(cues)
        # Keep the original: a re-run of our own output must not overwrite
        # it, but a newly downloaded subtitle becomes the new original. A
        # backup without a marker comes from an older helper — never replaced.
        os.makedirs(backup_dir, exist_ok=True)
        if source_path == srt_path and (os.path.isfile(marker_path) or not os.path.exists(backup_path)):
            # A backup is never overwritten: if this is wrong about what's
            # "new", the earlier original must still be there.
            if os.path.exists(backup_path):
                n = 1
                while os.path.exists(f"{backup_path}.{n}"):
                    n += 1
                os.replace(backup_path, f"{backup_path}.{n}")
            shutil.copy2(srt_path, backup_path)
        staged = srt_path + ".autosync.tmp"
        with open(staged, "w", encoding="utf-8-sig", newline="") as f:
            f.write(text)
        os.replace(staged, srt_path)
        with open(marker_path, "w", encoding="ascii") as f:
            f.write(_file_digest(srt_path))
        return offset, scale, segments, overlaps, islands, mode
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
            reference, ref_text = _pick_reference(os.path.join(folder, video), env)
            _alog(job, "dim", f"   subtitle: {srt} — aligning to {ref_text}…")
            ep_start = time.monotonic()
            try:
                offset, scale, segments, overlaps, islands, mode = _sync_one(job, folder, video, srt, env, cmd, reference)
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
            if mode == "single":
                parts_txt = ", one offset for the whole episode (it matches the video's cut)"
            elif mode == "marks":
                parts_txt = f", {segments} parts aligned separately at the translator's ad-break marks"
            elif mode == "inferred":
                parts_txt = f", {segments} parts aligned separately at the detected ad breaks"
            else:
                parts_txt = "" if segments == 1 else f", {segments} sections with different offsets"
            if islands:
                parts_txt += f", {islands} misplaced section(s) put back"
            if overlaps:
                parts_txt += f", {overlaps} overlapping line(s) fixed"
            _alog(job, "ok", f"   ✓ Synced — offset {off_txt}, framerate ×{scale_txt}{parts_txt} ({elapsed:.0f}s)")

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
        # A rename that only changes letter case finds the file itself on Windows.
        same_file = os.path.normcase(os.path.abspath(src)) == os.path.normcase(os.path.abspath(dest))
        if os.path.exists(dest) and not same_file:
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
