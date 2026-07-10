import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE_DIR  = r"C:\Elad\TV"
LIBRARY_DIR = r"H:\TV Shows"

VIDEO_EXTENSIONS    = {".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"}
SUBTITLE_EXTENSIONS = {".srt"}

# Matches S01E02 / s1e2 / 1x02 style episode tags
EPISODE_PATTERN = re.compile(
    r"^(.*?)[.\s_\-]+((?:S\d{1,2}E\d{1,2}|\d{1,2}x\d{2}))",
    re.IGNORECASE
)


# ---------------------------------------------------------------------------
# Copy with progress
# ---------------------------------------------------------------------------

CHUNK_SIZE = 4 * 1024 * 1024   # 4 MB per read cycle

# ANSI styling (supported by Windows 10/11 terminals)
_CYAN   = "\033[96m"
_GREEN  = "\033[92m"
_GRAY   = "\033[90m"
_RESET  = "\033[0m"

_BAR_WIDTH = 28
_BAR_FULL  = "█"
_BAR_EMPTY = "░"


def _format_size(n_bytes: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n_bytes < 1024:
            return f"{n_bytes:5.1f} {unit}"
        n_bytes /= 1024
    return f"{n_bytes:5.1f} TB"


def _format_eta(seconds: float) -> str:
    if seconds < 0 or seconds > 86400:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _render_bar(pct: float, color: str) -> str:
    filled = int(_BAR_WIDTH * pct)
    bar    = _BAR_FULL * filled + _BAR_EMPTY * (_BAR_WIDTH - filled)
    return f"{color}{bar}{_RESET}"


def copy_with_progress(src: str, dst: str) -> None:
    """
    Copy src -> dst in chunks, printing a live progress line to stdout.
    Preserves metadata (timestamps) like shutil.copy2.
    """
    total  = os.path.getsize(src)
    copied = 0
    start  = time.monotonic()

    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
        while True:
            chunk = fsrc.read(CHUNK_SIZE)
            if not chunk:
                break
            fdst.write(chunk)
            copied += len(chunk)

            elapsed = time.monotonic() - start
            speed   = copied / elapsed if elapsed > 0 else 0
            eta     = (total - copied) / speed if speed > 0 else -1
            pct     = copied / total if total > 0 else 1

            print(
                f"\r      {_render_bar(pct, _CYAN)}  "
                f"{pct*100:5.1f}%  "
                f"{_format_size(copied)} / {_format_size(total)}  "
                f"{_GRAY}{_format_size(speed)}/s · ETA {_format_eta(eta)}{_RESET}",
                end="", flush=True
            )

    # Preserve file metadata
    shutil.copystat(src, dst)
    elapsed = time.monotonic() - start
    speed   = total / elapsed if elapsed > 0 else 0

    print(
        f"\r      {_render_bar(1.0, _GREEN)}  "
        f"100.0%  "
        f"{_format_size(total)} / {_format_size(total)}  "
        f"{_GRAY}{_format_size(speed)}/s · done{_RESET}      "
    )


def move_with_progress(src: str, dst: str) -> None:
    """
    Move src -> dst with a live progress display.
    Tries os.rename first (instant, same drive); falls back to copy + delete.
    """
    try:
        os.rename(src, dst)
        size = os.path.getsize(dst)
        print(
            f"      {_render_bar(1.0, _GREEN)}  "
            f"100.0%  "
            f"{_format_size(size)} / {_format_size(size)}  "
            f"{_GRAY}instant · same drive{_RESET}"
        )
    except OSError:
        copy_with_progress(src, dst)
        os.remove(src)


# ---------------------------------------------------------------------------
# Filename parsing and normalization
# ---------------------------------------------------------------------------

def clean_series_name(raw: str) -> tuple:
    """
    Split a dot/underscore/dash/space-separated series name into two forms:
      name_for_file   -> Title.Case.With.Dots   (used in filenames)
      name_for_folder -> Title Case With Spaces  (used in folder names)
    """
    parts       = re.split(r"[.\s_\-]+", raw)
    parts       = [p for p in parts if p]
    capitalized = [p.capitalize() for p in parts]
    return ".".join(capitalized), " ".join(capitalized)


def normalize_episode_tag(tag: str) -> str:
    """Normalize any episode tag variant to S01E02 format."""
    m = re.match(r"(\d{1,2})x(\d{2})", tag, re.IGNORECASE)
    if m:
        return f"S{int(m.group(1)):02d}E{m.group(2)}"
    m = re.match(r"S(\d{1,2})E(\d{1,2})", tag, re.IGNORECASE)
    if m:
        return f"S{int(m.group(1)):02d}E{int(m.group(2)):02d}"
    return tag.upper()


def season_from_tag(episode_tag: str) -> int:
    """Extract the season number from a normalized S01E02 tag."""
    m = re.match(r"S(\d+)E\d+", episode_tag, re.IGNORECASE)
    return int(m.group(1)) if m else 1


def parse_filename(filename: str):
    """
    Return (series_file, series_folder, episode_tag, ext) for recognized files,
    or None if the file does not match a known pattern or extension.
    """
    name, ext = os.path.splitext(filename)
    if ext.lower() not in VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS:
        return None

    m = EPISODE_PATTERN.match(name)
    if not m:
        return None

    series_file, series_folder = clean_series_name(m.group(1))
    episode_tag                = normalize_episode_tag(m.group(2))
    return series_file, series_folder, episode_tag, ext.lower()


def build_new_filename(series_file: str, episode_tag: str, ext: str,
                       episode_name: str | None = None) -> str:
    base = f"{series_file}.{episode_tag}"
    if episode_name:
        base = f"{base}.{episode_name}"
    if ext == ".srt":
        return f"{base}.he{ext}"
    return f"{base}{ext}"


# ---------------------------------------------------------------------------
# TheTVDB v4 episode name lookup
# ---------------------------------------------------------------------------

# TODO: Fill in your TheTVDB v4 API key (https://thetvdb.com/dashboard/account/apikey)
TVDB_API_KEY = "ec2b6fb8-6a17-41eb-b245-c34a922f910e"

_TVDB_SHOW_CACHE: dict[str, int | None] = {}   # series_folder -> show_id or None
_TVDB_TOKEN: str | None = None
_HEBREW_RE = re.compile(r"[\u0590-\u05FF]")


def _is_hebrew(text: str) -> bool:
    """Return True if the text contains Hebrew characters."""
    return bool(_HEBREW_RE.search(text))


def _tvdb_login() -> str | None:
    """
    Log in to TheTVDB v4 API and return a bearer token, cached for the process lifetime.
    Returns None on failure.
    """
    global _TVDB_TOKEN
    if _TVDB_TOKEN:
        return _TVDB_TOKEN

    payload = json.dumps({"apikey": TVDB_API_KEY}).encode("utf-8")
    req = urllib.request.Request(
        "https://api4.thetvdb.com/v4/login",
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "organize_tv/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError):
        return None

    token = data.get("data", {}).get("token")
    if token:
        _TVDB_TOKEN = token
    return _TVDB_TOKEN


def _tvdb_get(url: str, _retries: int = 3) -> dict | list | None:
    """Perform an authenticated GET request to TheTVDB v4 API and return parsed JSON, or None on failure.

    Retries with a short delay on HTTP 429 (rate limit) before giving up.
    Also retries once on 401 in case the cached token expired.
    """
    token = _tvdb_login()
    if not token:
        return None

    for attempt in range(_retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "organize_tv/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < _retries - 1:
                retry_after = e.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else 1.0 * (attempt + 1)
                time.sleep(delay)
                continue
            if e.code == 401 and attempt == 0:
                # Token may have expired - force a fresh login and retry once
                global _TVDB_TOKEN
                _TVDB_TOKEN = None
                token = _tvdb_login()
                if not token:
                    return None
                continue
            return None
        except (urllib.error.URLError, json.JSONDecodeError, OSError):
            return None
    return None


def _search_show_id(query: str) -> tuple[int, str] | None:
    """
    Try to find a series on TheTVDB using the given query string.
    Returns (series_id, matched_name) or None.
    Uses the /search endpoint (type=series) and picks the highest-score result.
    """
    encoded = urllib.parse.quote(query)
    data    = _tvdb_get(f"https://api4.thetvdb.com/v4/search?query={encoded}&type=series")
    results = data.get("data") if isinstance(data, dict) else None
    if not isinstance(results, list) or not results:
        return None
    best = max(results, key=lambda r: r.get("score", 0))
    show_id = best.get("tvdb_id")
    name    = best.get("name", "")
    if show_id:
        return int(show_id), name
    return None


def _get_show_id(series_folder: str) -> tuple[int, str] | None:
    """
    Look up the TheTVDB series ID for a series, with caching.
    Tries progressively looser queries if the first search fails:
      1. Full series name as-is          e.g. "Breaking Bad"
      2. Without leading "The/A/An"      e.g. "The Bear"      -> "Bear"
      3. Without trailing country/year   e.g. "Euphoria Us"   -> "Euphoria"
                                              "Doctor Who 2005" -> "Doctor Who"
      4. First two words only            e.g. "Rick And Morty" -> "Rick And"
      5. Hyphenated variants             e.g. "Spider Noir"   -> "Spider-Noir"
    Returns (series_id, matched_name) or None.
    """
    cache_key = series_folder
    if cache_key in _TVDB_SHOW_CACHE:
        return _TVDB_SHOW_CACHE[cache_key]

    queries = [series_folder]

    # Strip common leading articles
    stripped = re.sub(r"^(The|A|An)\s+", "", series_folder, flags=re.IGNORECASE).strip()
    if stripped and stripped != series_folder:
        queries.append(stripped)

    # Strip trailing country codes (Us, Uk, Au, Ca, ...) or 4-digit years
    no_suffix = re.sub(
        r"\s+(Us|Uk|Au|Ca|Nz|Ie|Za|Us|De|Fr|Es|It|Jp|Kr|\d{4})$",
        "", series_folder, flags=re.IGNORECASE
    ).strip()
    if no_suffix and no_suffix != series_folder:
        queries.append(no_suffix)
        # Also try stripping article from the suffix-stripped version
        no_suffix_no_art = re.sub(r"^(The|A|An)\s+", "", no_suffix, flags=re.IGNORECASE).strip()
        if no_suffix_no_art and no_suffix_no_art != no_suffix:
            queries.append(no_suffix_no_art)

    # First two words only (helps with long titles)
    words = series_folder.split()
    if len(words) > 2:
        queries.append(" ".join(words[:2]))

    # Hyphenated variants: some shows use a hyphen instead of a space
    # between two of the title words, e.g. "Spider Noir" -> "Spider-Noir"
    if len(words) >= 2:
        for i in range(len(words) - 1):
            hyphenated = " ".join(words[:i] + [f"{words[i]}-{words[i+1]}"] + words[i+2:])
            queries.append(hyphenated)

    # Deduplicate while preserving order
    seen    = set()
    queries = [q for q in queries if not (q in seen or seen.add(q))]

    result = None
    for q in queries:
        result = _search_show_id(q)
        if result:
            break

    _TVDB_SHOW_CACHE[cache_key] = result
    return result


def _sanitize_episode_name(name: str) -> str:
    """
    Convert an episode name to dot-separated filename-safe format.
    Removes characters that are illegal in Windows filenames.
    """
    name = re.sub(r'[\\/:*?"<>|]', "", name)   # strip Windows-illegal chars
    name = re.sub(r"[\s\-]+", ".", name)         # spaces / dashes -> dots
    name = re.sub(r"\.{2,}", ".", name)          # collapse multiple dots
    return name.strip(".")


def _find_episode_via_full_list(show_id: int, season: int, episode: int) -> dict | None:
    """
    Fetch the full official episode list for a series and find the episode
    matching the given season/number.  TheTVDB paginates this endpoint,
    so pages are fetched until the match is found or the data runs out.
    """
    page = 0
    while True:
        data = _tvdb_get(
            f"https://api4.thetvdb.com/v4/series/{show_id}/episodes/official"
            f"?page={page}"
        )
        if not isinstance(data, dict):
            return None
        episodes = data.get("data", {}).get("episodes")
        if not isinstance(episodes, list) or not episodes:
            return None
        for ep in episodes:
            if ep.get("seasonNumber") == season and ep.get("number") == episode:
                return ep
        links = data.get("links", {})
        if links.get("next") is None:
            return None
        page += 1


def fetch_episode_name(series_folder: str, episode_tag: str) -> str | None:
    """
    Fetch the episode name from TheTVDB for the given series and episode tag.
    Prints a detailed status line indicating what was found or why it was skipped.
    Returns a dot-separated, filename-safe string, or None on any failure.
    """
    prefix = f"  [TheTVDB] {series_folder} {episode_tag}"

    if _is_hebrew(series_folder):
        print(f"{prefix} -> skipped (Hebrew series)")
        return None

    m = re.match(r"S(\d+)E(\d+)", episode_tag, re.IGNORECASE)
    if not m:
        print(f"{prefix} -> skipped (unrecognized tag format)")
        return None
    season, episode = int(m.group(1)), int(m.group(2))

    show_result = _get_show_id(series_folder)
    if show_result is None:
        print(f"{prefix} -> show not found on TheTVDB")
        return None
    show_id, matched_name = show_result

    data = _find_episode_via_full_list(show_id, season, episode)

    if not isinstance(data, dict):
        print(f"{prefix} -> show matched as '{matched_name}' (id={show_id})"
              f" but S{season:02d}E{episode:02d} not found in episode list")
        return None

    name = (data.get("name") or "").strip()
    if not name:
        print(f"{prefix} -> show matched as '{matched_name}' (id={show_id}) but episode name is empty")
        return None

    if _is_hebrew(name):
        print(f"{prefix} -> episode name is Hebrew, skipping")
        return None

    safe_name = _sanitize_episode_name(name)
    print(f"{prefix} -> '{matched_name}' (id={show_id}) S{season:02d}E{episode:02d} = {safe_name}")
    return safe_name


# ---------------------------------------------------------------------------
# Library helpers  (H:\TV Shows logic)
# ---------------------------------------------------------------------------

def find_season_folder(series_lib_dir: str, season_num: int) -> str | None:
    """
    Look for an existing season subfolder inside series_lib_dir that matches
    the given season number.  Recognises common naming conventions:
      Season 1 / Season 01 / S01 / Series 1 / Series 01
    Returns the full path if found, otherwise None.
    """
    if not os.path.isdir(series_lib_dir):
        return None

    patterns = [
        re.compile(rf"^season\s*0*{season_num}$", re.IGNORECASE),
        re.compile(rf"^series\s*0*{season_num}$", re.IGNORECASE),
        re.compile(rf"^s0*{season_num}$",          re.IGNORECASE),
    ]

    for entry in os.scandir(series_lib_dir):
        if entry.is_dir():
            for pat in patterns:
                if pat.match(entry.name):
                    return entry.path
    return None


def resolve_library_dest(series_folder: str, episode_tag: str) -> tuple:
    """
    Determine the final destination directory for a file inside H:\\TV Shows.

    Returns (dest_dir, situation) where situation is one of:
      "new_series"    - series folder does not exist yet in the library
      "flat_series"   - series folder exists but has no season subfolders
      "season_found"  - series folder exists and a matching season folder was found
      "season_created"- series folder exists but no season folder matched; one was created
    """
    season_num      = season_from_tag(episode_tag)
    series_lib_dir  = os.path.join(LIBRARY_DIR, series_folder)

    if not os.path.isdir(series_lib_dir):
        return series_lib_dir, "new_series"

    # Series folder exists - look for season subfolders
    season_dir = find_season_folder(series_lib_dir, season_num)
    if season_dir:
        return season_dir, "season_found"

    # Check whether any season-like subfolders exist at all
    has_subfolders = any(
        e.is_dir() for e in os.scandir(series_lib_dir)
    )

    if has_subfolders:
        # Subfolders exist but none matched - create the appropriate season folder
        new_season_dir = os.path.join(series_lib_dir, f"Season {season_num:02d}")
        os.makedirs(new_season_dir, exist_ok=True)
        return new_season_dir, "season_created"

    # Series folder exists and is flat (no subfolders) - drop files directly in
    return series_lib_dir, "flat_series"


# ---------------------------------------------------------------------------
# File collection
# ---------------------------------------------------------------------------

def collect_files(directory: str) -> list:
    """
    Scan the top level of directory and return all recognized files.
    Episode names are fetched from TheTVDB where possible.
    A per-series cache avoids redundant API calls across video + subtitle pairs.
    """
    found = []
    ep_name_cache: dict[tuple, str | None] = {}   # (series_folder, episode_tag) -> name

    for entry in os.scandir(directory):
        if not entry.is_file():
            continue
        result = parse_filename(entry.name)
        if not result:
            continue

        series_file, series_folder, episode_tag, ext = result
        key = (series_folder, episode_tag)

        if key not in ep_name_cache:
            ep_name_cache[key] = fetch_episode_name(series_folder, episode_tag)

        ep_name = ep_name_cache[key]
        found.append({
            "original_path": entry.path,
            "original_name": entry.name,
            "series_file":   series_file,
            "series_folder": series_folder,
            "episode_tag":   episode_tag,
            "episode_name":  ep_name,
            "ext":           ext,
            "new_name":      build_new_filename(series_file, episode_tag, ext, ep_name),
        })
    return found


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------

def preview(files: list) -> None:
    if not files:
        print("  (no matching files found)")
        return
    max_orig = max(len(f["original_name"]) for f in files)
    for f in files:
        print(f"  {f['original_name']:<{max_orig}}  -->  {f['new_name']}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 65)
    print("  TV File Organizer")
    print(f"  Source  : {SOURCE_DIR}")
    print(f"  Library : {LIBRARY_DIR}")
    print("=" * 65)

    if not os.path.isdir(SOURCE_DIR):
        print(f"\n[ERROR] Source folder not found: {SOURCE_DIR}")
        return

    files = collect_files(SOURCE_DIR)

    if not files:
        print("\nNo video or subtitle files with a recognized naming pattern found.")
        return

    # Sync SRT filenames to exactly match their paired video file (case + dots)
    video_name_map = {
        (f["series_folder"], f["episode_tag"]): f["series_file"]
        for f in files
        if f["ext"] in VIDEO_EXTENSIONS
    }
    for f in files:
        if f["ext"] in SUBTITLE_EXTENSIONS:
            key = (f["series_folder"], f["episode_tag"])
            if key in video_name_map:
                f["series_file"] = video_name_map[key]
                f["new_name"]    = build_new_filename(
                    f["series_file"], f["episode_tag"], f["ext"], f["episode_name"]
                )

    # Show detected series
    series_set = sorted(set(f["series_folder"] for f in files))
    print(f"\nDetected series ({len(series_set)}):")
    for s in series_set:
        count = sum(1 for f in files if f["series_folder"] == s)
        lib_path = os.path.join(LIBRARY_DIR, s)
        status   = "exists in library" if os.path.isdir(lib_path) else "new - will be created"
        print(f"  - {s}  ({count} file(s))  [{status}]")

    # Show planned renames
    print(f"\nPlanned renames ({len(files)} file(s)):")
    preview(files)

    # Summarize and confirm
    print()
    print("Will perform:")
    print("  - Rename files")
    print("  - Move video files / copy SRT files (originals kept)")
    print("  - Move new series folders to library, or merge into existing ones")

    confirm = input("Proceed? (Y/N): ").strip().upper()
    if confirm != "Y":
        print("Cancelled. No changes made.")
        return

    # --- Execute ---
    errors          = []
    success         = 0
    new_series_dirs = set()

    for f in files:
        try:
            is_subtitle = f["ext"] in SUBTITLE_EXTENSIONS

            # Stage into SOURCE_DIR first, then resolve library destination later
            stage_dir = os.path.join(SOURCE_DIR, f["series_folder"])
            os.makedirs(stage_dir, exist_ok=True)
            dest_path = os.path.join(stage_dir, f["new_name"])

            # Skip if already in the right place
            if os.path.abspath(f["original_path"]) == os.path.abspath(dest_path):
                print(f"  [SKIP - already correct] {f['original_name']}")
                success += 1
                continue

            # Do not silently overwrite an existing file
            if os.path.exists(dest_path):
                print(f"  [WARNING - destination exists, skipped] {dest_path}")
                errors.append(f["original_name"])
                continue

            if is_subtitle:
                print(f"\n  📄 {f['original_name']}")
                print(f"     {_GRAY}→ {dest_path}{_RESET}")
                copy_with_progress(f["original_path"], dest_path)
            else:
                print(f"\n  🎬 {f['original_name']}")
                print(f"     {_GRAY}→ {dest_path}{_RESET}")
                move_with_progress(f["original_path"], dest_path)

            success += 1
            new_series_dirs.add((f["series_folder"], stage_dir))

        except Exception as e:
            print(f"  [ERROR] {f['original_name']}: {e}")
            errors.append(f["original_name"])

    # --- Move / merge into H:\TV Shows ---
    if new_series_dirs:
        print()
        print("Moving files to library...")

        if not os.path.isdir(LIBRARY_DIR):
            print(f"  [WARNING] Library folder not found: {LIBRARY_DIR}")
            print("  Staged files remain in source folder.")
        else:
            for series_folder, stage_dir in sorted(new_series_dirs):
                if not os.path.isdir(stage_dir):
                    continue

                for filename in os.listdir(stage_dir):
                    src = os.path.join(stage_dir, filename)
                    if not os.path.isfile(src):
                        continue

                    # Find the episode tag from the filename to resolve season folder
                    m = re.search(r"S\d{2}E\d{2}", filename, re.IGNORECASE)
                    ep_tag   = m.group(0).upper() if m else "S01E01"
                    dest_dir, situation = resolve_library_dest(series_folder, ep_tag)

                    os.makedirs(dest_dir, exist_ok=True)
                    dest_file = os.path.join(dest_dir, filename)

                    if os.path.exists(dest_file):
                        print(f"  [WARNING - exists in library, skipped] {dest_file}")
                        continue

                    print(f"\n  📦 {filename}")
                    print(f"     {_GRAY}→ {dest_dir}  [{situation}]{_RESET}")
                    move_with_progress(src, dest_file)

                # Remove the now-empty staging folder
                try:
                    if not os.listdir(stage_dir):
                        os.rmdir(stage_dir)
                except OSError:
                    pass

    print()
    print("=" * 65)
    print(f"  Done: {success} file(s) processed successfully, {len(errors)} error(s).")
    print("=" * 65)

    if errors:
        print("\nFiles not processed:")
        for name in errors:
            print(f"  - {name}")


if __name__ == "__main__":
    main()