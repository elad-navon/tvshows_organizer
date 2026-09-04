
"use strict";

// ---------------------------------------------------------------------------
// Config (ported from tvshows_organizer.py)
// ---------------------------------------------------------------------------
const VIDEO_EXT = new Set([".mkv",".mp4",".avi",".mov",".wmv",".m4v"]);
const SUBTITLE_EXT = new Set([".srt"]);
const EPISODE_PATTERN = /^(.*?)[.\s_-]+((?:S\d{1,2}E\d{1,2}|\d{1,2}x\d{2}))/i;
// Entered by the user in the "TMDB API key" field and kept only in this
// browser's localStorage — never committed to this public repo, and never
// sent anywhere except directly to api.themoviedb.org.
let TMDB_API_KEY = localStorage.getItem("tmdbApiKey") || "";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const HEBREW_RE = /[\u0590-\u05FF]/;

// Manual TMDB id overrides for series that can't be found reliably through
// the /search/tv endpoint — most often because a show has no English name
// or alias recorded for it yet (e.g. Israeli shows only listed under their
// Hebrew name), so no amount of query-massaging or name-matching will find
// them by text. Key is the exact seriesFolder text (as cleanSeriesName
// produces it); value is the TMDB series id from its themoviedb.org URL.
const MANUAL_SHOW_OVERRIDES = {
  "On Standby": 329297,   // TMDB name is "בודקת" (Bodeket) — no English name/alias on file
};

// ---------------------------------------------------------------------------
// IndexedDB — persist the two directory handles between sessions
// ---------------------------------------------------------------------------
function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("tv-organizer", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readonly").objectStore("handles").get(key);
    tx.onsuccess = () => resolve(tx.result || null);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbSet(key, value){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite").objectStore("handles").put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite").objectStore("handles").delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Filename parsing / normalization (ported 1:1)
// ---------------------------------------------------------------------------
function cleanSeriesName(raw){
  const parts = raw.split(/[.\s_-]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return [parts.join("."), parts.join(" ")];
}
function normalizeEpisodeTag(tag){
  let m = tag.match(/^(\d{1,2})x(\d{2})$/i);
  if (m) return `S${String(parseInt(m[1],10)).padStart(2,"0")}E${m[2]}`;
  m = tag.match(/^S(\d{1,2})E(\d{1,2})$/i);
  if (m) return `S${String(parseInt(m[1],10)).padStart(2,"0")}E${String(parseInt(m[2],10)).padStart(2,"0")}`;
  return tag.toUpperCase();
}
function seasonFromTag(tag){
  const m = tag.match(/^S(\d+)E\d+/i);
  return m ? parseInt(m[1],10) : 1;
}
function parseFilename(filename){
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  const name = filename.slice(0, dot);
  const ext = filename.slice(dot).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !SUBTITLE_EXT.has(ext)) return null;
  const m = EPISODE_PATTERN.exec(name);
  if (!m) return null;
  const [seriesFile, seriesFolder] = cleanSeriesName(m[1]);
  const episodeTag = normalizeEpisodeTag(m[2]);
  return { seriesFile, seriesFolder, episodeTag, ext };
}
function buildNewFilename(seriesFile, episodeTag, ext, episodeName){
  let base = `${seriesFile}.${episodeTag}`;
  if (episodeName) base = `${base}.${episodeName}`;
  return ext === ".srt" ? `${base}.he${ext}` : `${base}${ext}`;
}
function isHebrew(text){ return HEBREW_RE.test(text); }
function sanitizeEpisodeName(name){
  name = name.replace(/[\\/:*?"<>|]/g, "");
  name = name.replace(/[\s-]+/g, ".");
  name = name.replace(/\.{2,}/g, ".");
  return name.replace(/^\.+|\.+$/g, "");
}
function formatSize(n){
  const units = ["B","KB","MB","GB"];
  for (const u of units){ if (n < 1024) return `${n.toFixed(1)} ${u}`; n /= 1024; }
  return `${n.toFixed(1)} TB`;
}

// ---------------------------------------------------------------------------
// TMDB v3 lookup (ported, best-effort — degrades silently on CORS failure)
// ---------------------------------------------------------------------------
let tmdbBlocked = false;
const tmdbShowCache = new Map();
let seriesPosterMap = new Map();

function tmdbPosterUrl(posterPath){
  return posterPath ? `${TMDB_IMAGE_BASE}${posterPath}` : null;
}
async function tmdbGet(url, retries=2){
  if (!TMDB_API_KEY){ tmdbBlocked = true; return null; }
  for (let attempt=0; attempt<retries; attempt++){
    try{
      const res = await fetch(url);
      if (res.status === 429){
        await new Promise(r => setTimeout(r, 1000*(attempt+1)));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch(e){
      tmdbBlocked = true;
      return null;
    }
  }
  return null;
}
function looksLikeMatch(query, candidateName){
  // Sanity-check TMDB's own top pick against the text we actually searched
  // for. TMDB's search can return a "least bad" result even when nothing
  // good matches — e.g. a query of "On Standby" (a show with no English
  // name/alias on TMDB) can return a completely unrelated show as its top
  // hit purely from letter overlap. Requiring every real word of the query
  // to also appear as a whole word in the candidate's name catches that,
  // while still allowing the candidate to have extra words the query didn't
  // ("The", a subtitle, etc.) — normal, and shouldn't be rejected. Numeric
  // tokens (years) are ignored; those are handled separately via expectedYear.
  const words = s => new Set((s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !/^\d+$/.test(w)));
  const queryWords = words(query);
  if (!queryWords.size) return true;
  const nameWords = words(candidateName);
  for (const w of queryWords) if (!nameWords.has(w)) return false;
  return true;
}
async function fetchSeriesById(id){
  const data = await tmdbGet(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}`);
  if (!data || data.id == null) return null;
  return { id, name: data.name || "", posterUrl: tmdbPosterUrl(data.poster_path) };
}
async function searchShowId(query, expectedYear){
  const data = await tmdbGet(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
  const results = data?.results;
  if (!Array.isArray(results) || !results.length) return null;
  // When the release name carried a year, prefer a candidate whose TMDB
  // first-air year matches it over whichever candidate merely scored
  // highest — two unrelated shows can share the exact same title (e.g.
  // "Betrayal" 2013 vs 2023), and a bare popularity pick will silently
  // grab the wrong one. Only fall back to pure popularity when no
  // candidate's year matches (or the show has no air date on record).
  let pool = results;
  if (expectedYear){
    const yearMatches = results.filter(r => (r.first_air_date || "").slice(0,4) === String(expectedYear));
    if (yearMatches.length) pool = yearMatches;
  }
  const best = pool.reduce((a,b) => (b.popularity||0) > (a.popularity||0) ? b : a);
  if (best?.id == null) return null;
  if (!looksLikeMatch(query, best.name || "")) return null;
  return {
    id: best.id,
    name: best.name || "",
    posterUrl: tmdbPosterUrl(best.poster_path),
  };
}
async function getShowId(seriesFolder){
  if (tmdbShowCache.has(seriesFolder)) return tmdbShowCache.get(seriesFolder);
  if (MANUAL_SHOW_OVERRIDES[seriesFolder] != null){
    const result = await fetchSeriesById(MANUAL_SHOW_OVERRIDES[seriesFolder])
      || { id: MANUAL_SHOW_OVERRIDES[seriesFolder], name: `${seriesFolder} (manual override)`, posterUrl: null };
    tmdbShowCache.set(seriesFolder, result);
    return result;
  }
  // Try the "cleanest" queries first — a trailing year or country code is
  // usually part of the release name, not the show's actual title, and
  // searching with it still attached can return a confident-looking but
  // wrong match (e.g. a different, unrelated show), which would stop us
  // from ever trying the accurate query. The raw name is kept as a
  // fallback in case the stripped year genuinely was part of the title.
  const yearMatch = seriesFolder.match(/\s+(\d{4})$/);
  const expectedYear = yearMatch ? yearMatch[1] : null;
  const queries = [];
  const noSuffix = seriesFolder.replace(/\s+(Us|Uk|Au|Ca|Nz|Ie|Za|De|Fr|Es|It|Jp|Kr|\d{4})$/i, "").trim();
  if (noSuffix && noSuffix !== seriesFolder){
    queries.push(noSuffix);
    const noSuffixNoArt = noSuffix.replace(/^(The|A|An)\s+/i, "").trim();
    if (noSuffixNoArt && noSuffixNoArt !== noSuffix) queries.push(noSuffixNoArt);
  }
  queries.push(seriesFolder);
  const stripped = seriesFolder.replace(/^(The|A|An)\s+/i, "").trim();
  if (stripped && stripped !== seriesFolder) queries.push(stripped);
  const words = seriesFolder.split(" ");
  if (words.length > 2) queries.push(words.slice(0,2).join(" "));
  const seen = new Set();
  const uniq = queries.filter(q => !seen.has(q) && seen.add(q));

  let result = null;
  for (const q of uniq){
    result = await searchShowId(q, expectedYear);
    if (result || tmdbBlocked) break;
  }
  tmdbShowCache.set(seriesFolder, result);
  return result;
}
async function fetchEpisodeName(seriesFolder, episodeTag, log){
  if (tmdbBlocked) return null;
  if (isHebrew(seriesFolder)) return null;
  const m = episodeTag.match(/^S(\d+)E(\d+)$/i);
  if (!m) return null;
  const season = parseInt(m[1],10), episode = parseInt(m[2],10);
  const show = await getShowId(seriesFolder);
  if (!show) { log(`[TMDB] ${seriesFolder} ${episodeTag} -> no matching series found`, "dim"); return null; }
  if (show.posterUrl) seriesPosterMap.set(seriesFolder, show.posterUrl);
  const data = await tmdbGet(`https://api.themoviedb.org/3/tv/${show.id}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`);
  const name = (data?.name || "").trim();
  if (!name) { log(`[TMDB] ${seriesFolder} ${episodeTag} -> "${show.name}" found but no episode name`, "dim"); return null; }
  if (isHebrew(name)) return null;
  const safe = sanitizeEpisodeName(name);
  log(`[TMDB] ${seriesFolder} ${episodeTag} -> "${show.name}" = ${safe}`, "dim");
  return safe;
}

// ---------------------------------------------------------------------------
// Library folder resolution (ported)
// ---------------------------------------------------------------------------
async function findSeasonFolder(seriesLibDirHandle, seasonNum){
  const patterns = [
    new RegExp(`^season\\s*0*${seasonNum}$`, "i"),
    new RegExp(`^series\\s*0*${seasonNum}$`, "i"),
    new RegExp(`^s0*${seasonNum}$`, "i"),
  ];
  for await (const [name, handle] of seriesLibDirHandle.entries()){
    if (handle.kind === "directory" && patterns.some(p => p.test(name))) return handle;
  }
  return null;
}
async function resolveLibraryDest(libraryDirHandle, seriesFolder, episodeTag){
  const seasonNum = seasonFromTag(episodeTag);
  let seriesLibDirHandle, exists = true;
  try { seriesLibDirHandle = await libraryDirHandle.getDirectoryHandle(seriesFolder, {create:false}); }
  catch(e){ exists = false; }

  if (!exists){
    seriesLibDirHandle = await libraryDirHandle.getDirectoryHandle(seriesFolder, {create:true});
    return { dirHandle: seriesLibDirHandle, situation: "new_series", relDir: [seriesFolder] };
  }
  const seasonDir = await findSeasonFolder(seriesLibDirHandle, seasonNum);
  if (seasonDir) return { dirHandle: seasonDir, situation: "season_found", relDir: [seriesFolder, seasonDir.name] };

  let hasSubfolders = false;
  for await (const [, handle] of seriesLibDirHandle.entries()){
    if (handle.kind === "directory"){ hasSubfolders = true; break; }
  }
  if (hasSubfolders){
    const seasonName = `Season ${String(seasonNum).padStart(2,"0")}`;
    const newSeasonDir = await seriesLibDirHandle.getDirectoryHandle(seasonName, {create:true});
    return { dirHandle: newSeasonDir, situation: "season_created", relDir: [seriesFolder, seasonName] };
  }
  return { dirHandle: seriesLibDirHandle, situation: "flat_series", relDir: [seriesFolder] };
}

// ---------------------------------------------------------------------------
// File move (fast path via handle.move() when supported, else copy+delete)
// ---------------------------------------------------------------------------
async function copyFileWithProgress(file, destDirHandle, destName, onProgress){
  // Large fixed chunks instead of the stream's default (small) chunk size —
  // each write() is an async round-trip to the browser's file-system backend,
  // so fewer/bigger writes means far less overhead for big video files.
  const CHUNK = 64 * 1024 * 1024; // 64MB
  const total = file.size;
  let copied = 0;
  const start = performance.now();
  const destHandle = await destDirHandle.getFileHandle(destName, {create:true});
  const writable = await destHandle.createWritable();
  let lastUpdate = 0;
  while (copied < total){
    const end = Math.min(copied + CHUNK, total);
    const buf = await file.slice(copied, end).arrayBuffer();
    await writable.write(buf);
    copied = end;
    const now = performance.now();
    if (now - lastUpdate > 120 || copied === total){
      onProgress(copied, total, start);
      lastUpdate = now;
    }
  }
  // All bytes are written, but the browser still has to flush the writable
  // stream and atomically swap it into place — on a network/NAS destination
  // or with antivirus scanning the new file, this can take many seconds
  // with no further progress events, so tell the user we're still working.
  onProgress(total, total, start, "finalizing");
  await writable.close();
}
async function moveFile(srcDirHandle, srcName, destDirHandle, destName, onProgress){
  const srcHandle = await srcDirHandle.getFileHandle(srcName);
  if (typeof srcHandle.move === "function"){
    try{
      await srcHandle.move(destDirHandle, destName);
      onProgress(1, 1, performance.now(), true);
      return;
    } catch(e){ /* fall through */ }
  }
  const file = await srcHandle.getFile();
  await copyFileWithProgress(file, destDirHandle, destName, onProgress);
  await srcDirHandle.removeEntry(srcName);
}

// ---------------------------------------------------------------------------
// Local helper (optional) — a tiny script the user runs on their own machine
// (see helper.py) that moves files with a native OS rename/copy instead of
// going through the browser's File System Access API. Bypassed entirely
// unless the user opts in and configures real filesystem paths, since the
// browser has no way to learn the real path behind a picked folder handle.
// ---------------------------------------------------------------------------
const HELPER_BASE = "http://127.0.0.1:8765";
async function pingHelper(){
  try{
    const res = await fetch(`${HELPER_BASE}/ping`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
  } catch(e){ return false; }
}
function joinPath(...parts){
  return parts.map(p => String(p).replace(/[\\/]+$/, "")).join("\\");
}
async function moveFileViaHelper(srcPath, destPath, onProgress){
  const startRes = await fetch(`${HELPER_BASE}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src: srcPath, dest: destPath }),
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData.ok || !startData.job) throw new Error(startData.error || `Local helper move failed (HTTP ${startRes.status})`);

  // Same-drive moves are a metadata-only rename with nothing to report
  // progress on — they're usually already done by the first poll below,
  // in which case we show the same "instant" treatment as the browser's
  // own same-folder fast path instead of a progress bar that never moves.
  const start = performance.now();
  let sawProgress = false;
  while (true){
    await new Promise(r => setTimeout(r, 150));
    const res = await fetch(`${HELPER_BASE}/progress?job=${encodeURIComponent(startData.job)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Local helper progress check failed (HTTP ${res.status})`);
    if (data.error) throw new Error(data.error);
    if (data.done){
      if (!sawProgress) onProgress(1, 1, performance.now(), "native");
      else onProgress(data.total || 1, data.total || 1, start);
      return;
    }
    if (data.total > 0){
      sawProgress = true;
      onProgress(data.copied, data.total, start);
    }
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const els = {
  sourceName: document.getElementById("sourceName"),
  sourceDot: document.getElementById("sourceDot"),
  sourceStatus: document.getElementById("sourceStatus"),
  sourceBtn: document.getElementById("sourceBtn"),
  sourceBtnLabel: document.getElementById("sourceBtnLabel"),
  libName: document.getElementById("libName"),
  libDot: document.getElementById("libDot"),
  libStatus: document.getElementById("libStatus"),
  libBtn: document.getElementById("libBtn"),
  libBtnLabel: document.getElementById("libBtnLabel"),
  resetBtn: document.getElementById("resetBtn"),
  helperCheck: document.getElementById("helperCheck"),
  helperStatusRow: document.getElementById("helperStatusRow"),
  helperDot: document.getElementById("helperDot"),
  helperStatus: document.getElementById("helperStatus"),
  helperPaths: document.getElementById("helperPaths"),
  helperSourcePath: document.getElementById("helperSourcePath"),
  helperLibraryPath: document.getElementById("helperLibraryPath"),
  helperHint: document.getElementById("helperHint"),
  scanBtn: document.getElementById("scanBtn"),
  tmdbCheck: document.getElementById("tmdbCheck"),
  tmdbKeyInput: document.getElementById("tmdbKeyInput"),
  tmdbBanner: document.getElementById("tmdbBanner"),
  scanResults: document.getElementById("scanResults"),
  executePanel: document.getElementById("executePanel"),
  runBtn: document.getElementById("runBtn"),
  log: document.getElementById("log"),
  logEmpty: document.getElementById("logEmpty"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  summary: document.getElementById("summary"),
  statSeries: document.getElementById("statSeries"),
  statFiles: document.getElementById("statFiles"),
  statSize: document.getElementById("statSize"),
  statTime: document.getElementById("statTime"),
  statPending: document.getElementById("statPending"),
  statProcessed: document.getElementById("statProcessed"),
  statExecTime: document.getElementById("statExecTime"),
  themeToggle: document.getElementById("themeToggle"),
};
let lastScanSeconds = 0;

let sourceHandle = null;
let libraryHandle = null;
let scannedFiles = [];

function escapeHtml(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function plural(n, singular, pluralForm){
  return n === 1 ? singular : (pluralForm || `${singular}s`);
}
function formatDuration(totalSeconds){
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const wholeSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
function breakable(s){
  // Insert a break opportunity after each dot/underscore/hyphen so long
  // filenames wrap between segments — never in the middle of one.
  return escapeHtml(s).replace(/([._-])/g, "$1<wbr>");
}
function logLine(text, cls){
  els.logEmpty.style.display = "none";
  els.log.style.display = "block";
  const row = document.createElement("div");
  row.className = "row" + (cls ? " " + cls : "");
  row.textContent = text;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
  return row;
}
function logLineHTML(html, cls){
  els.logEmpty.style.display = "none";
  els.log.style.display = "block";
  const row = document.createElement("div");
  row.className = "row" + (cls ? " " + cls : "");
  row.innerHTML = html;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
  return row;
}
els.themeToggle.addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const next = isLight ? "dark" : "light";
  if (next === "dark") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", "light");
  try { localStorage.setItem("uiTheme", next); } catch (e) {}
});
els.clearLogBtn.addEventListener("click", () => {
  els.log.innerHTML = "";
  els.log.style.display = "none";
  els.logEmpty.style.display = "block";
  els.summary.textContent = "";
});
function progressRow(){
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<div class="pbar-wrap">
      <div class="pbar-track"><div class="pbar-fill"></div></div>
      <span class="pbar-text">0%</span>
    </div>`;
  els.log.style.display = "block";
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
  const fill = row.querySelector(".pbar-fill");
  const text = row.querySelector(".pbar-text");
  return {
    update(copied, total, start, instant){
      if (instant === "finalizing"){
        text.innerHTML = `100% <span class="dim">— finishing write… (can take a while for large/network folders)</span>`;
        return;
      }
      if (instant === "native"){
        fill.classList.add("done");
        fill.style.width = "100%";
        text.innerHTML = `100% <span class="dim">— via local helper</span>`;
        return;
      }
      if (instant){
        fill.classList.add("done");
        fill.style.width = "100%";
        text.innerHTML = `100% <span class="dim">— instant (same folder)</span>`;
        return;
      }
      const pct = total > 0 ? copied/total : 1;
      const elapsed = (performance.now() - start) / 1000;
      const speed = elapsed > 0 ? copied/elapsed : 0;
      if (pct >= 1) fill.classList.add("done");
      fill.style.width = `${(pct*100).toFixed(1)}%`;
      text.innerHTML = `${(pct*100).toFixed(0)}% <span class="dim">${formatSize(copied)} / ${formatSize(total)} — ${formatSize(speed)}/s</span>`;
      els.log.scrollTop = els.log.scrollHeight;
    }
  };
}

async function refreshFolderUI(){
  if (sourceHandle){
    els.sourceName.textContent = sourceHandle.name;
    els.sourceName.classList.remove("empty");
    const perm = await sourceHandle.queryPermission({ mode: "readwrite" });
    if (perm === "granted"){
      els.sourceDot.className = "dot ok"; els.sourceStatus.textContent = "Connected";
      els.sourceBtnLabel.textContent = "Change folder…";
    } else {
      els.sourceDot.className = "dot warn"; els.sourceStatus.textContent = "Access permission required";
      els.sourceBtnLabel.textContent = "Grant access";
    }
  } else {
    els.sourceName.textContent = "No folder selected"; els.sourceName.classList.add("empty");
    els.sourceDot.className = "dot"; els.sourceStatus.textContent = "—";
    els.sourceBtnLabel.textContent = "Choose folder…";
  }
  if (libraryHandle){
    els.libName.textContent = libraryHandle.name;
    els.libName.classList.remove("empty");
    const perm = await libraryHandle.queryPermission({ mode: "readwrite" });
    if (perm === "granted"){
      els.libDot.className = "dot ok"; els.libStatus.textContent = "Connected";
      els.libBtnLabel.textContent = "Change folder…";
    } else {
      els.libDot.className = "dot warn"; els.libStatus.textContent = "Access permission required";
      els.libBtnLabel.textContent = "Grant access";
    }
  } else {
    els.libName.textContent = "No folder selected"; els.libName.classList.add("empty");
    els.libDot.className = "dot"; els.libStatus.textContent = "—";
    els.libBtnLabel.textContent = "Choose folder…";
  }
  els.scanBtn.disabled = !(sourceHandle && libraryHandle
    && (await sourceHandle.queryPermission({mode:"readwrite"})) === "granted"
    && (await libraryHandle.queryPermission({mode:"readwrite"})) === "granted");
}

async function connectFolder(kind){
  const isSource = kind === "source";
  const existing = isSource ? sourceHandle : libraryHandle;
  if (existing){
    // Try to just re-request permission first (no picker) if it's the same handle
    const perm = await existing.queryPermission({ mode: "readwrite" });
    if (perm !== "granted"){
      const res = await existing.requestPermission({ mode: "readwrite" });
      if (res === "granted"){ await refreshFolderUI(); return; }
    }
  }
  try{
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (isSource){ sourceHandle = handle; await idbSet("source", handle); }
    else { libraryHandle = handle; await idbSet("library", handle); }
    await refreshFolderUI();
  } catch(e){ /* user cancelled */ }
}

els.sourceBtn.addEventListener("click", () => connectFolder("source"));
els.libBtn.addEventListener("click", () => connectFolder("library"));
els.resetBtn.addEventListener("click", async () => {
  await idbDel("source"); await idbDel("library");
  sourceHandle = null; libraryHandle = null;
  scannedFiles = [];
  els.scanResults.innerHTML = "";
  els.runBtn.disabled = true;
  els.statPending.textContent = "0";
  els.statProcessed.textContent = "0";
  els.statExecTime.textContent = "–";
  await refreshFolderUI();
});

function safeSetItem(key, value){
  try{
    localStorage.setItem(key, value);
    return true;
  } catch(e){
    console.error(`localStorage.setItem("${key}") failed — storage quota likely full for this site.`, e);
    return false;
  }
}

els.tmdbKeyInput.value = TMDB_API_KEY;
els.tmdbKeyInput.addEventListener("input", () => {
  TMDB_API_KEY = els.tmdbKeyInput.value.trim();
  safeSetItem("tmdbApiKey", TMDB_API_KEY);
});

async function refreshHelperUI(){
  const enabled = els.helperCheck.checked;
  els.helperPaths.style.display = enabled ? "flex" : "none";
  els.helperHint.style.display = enabled ? "block" : "none";
  els.helperStatusRow.style.display = enabled ? "flex" : "none";
  if (!enabled) return;
  const ok = await pingHelper();
  els.helperDot.className = ok ? "dot ok" : "dot warn";
  els.helperStatus.textContent = ok ? "Helper connected" : "Helper not reachable — start start_helper.bat";
}
els.helperCheck.checked = localStorage.getItem("helperEnabled") === "1";
els.helperCheck.addEventListener("change", () => {
  safeSetItem("helperEnabled", els.helperCheck.checked ? "1" : "0");
  refreshHelperUI();
});
els.helperSourcePath.value = localStorage.getItem("helperSourcePath") || "";
els.helperSourcePath.addEventListener("input", () => {
  if (!safeSetItem("helperSourcePath", els.helperSourcePath.value.trim())){
    els.helperStatus.textContent = "Couldn't save — this browser's storage for this site is full";
    els.helperDot.className = "dot warn";
  }
});
els.helperLibraryPath.value = localStorage.getItem("helperLibraryPath") || "";
els.helperLibraryPath.addEventListener("input", () => {
  if (!safeSetItem("helperLibraryPath", els.helperLibraryPath.value.trim())){
    els.helperStatus.textContent = "Couldn't save — this browser's storage for this site is full";
    els.helperDot.className = "dot warn";
  }
});

(async function init(){
  sourceHandle = await idbGet("source");
  libraryHandle = await idbGet("library");
  await refreshFolderUI();
  await refreshHelperUI();
})();

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
els.scanBtn.addEventListener("click", async () => {
  els.scanBtn.disabled = true;
  els.scanResults.innerHTML = "<div class=\"empty-hint\">Scanning…</div>";
  els.tmdbBanner.classList.remove("show");
  tmdbBlocked = false;
  seriesPosterMap = new Map();
  const t0 = performance.now();

  const useTmdb = els.tmdbCheck.checked;
  const found = [];
  const epNameCache = new Map();

  for await (const [name, handle] of sourceHandle.entries()){
    if (handle.kind !== "file") continue;
    const parsed = parseFilename(name);
    if (!parsed) continue;
    const key = `${parsed.seriesFolder}::${parsed.episodeTag}`;
    if (useTmdb && !epNameCache.has(key)){
      epNameCache.set(key, await fetchEpisodeName(parsed.seriesFolder, parsed.episodeTag, (t)=>{}));
    }
    const episodeName = useTmdb ? (epNameCache.get(key) || null) : null;
    const size = (await handle.getFile()).size;
    found.push({
      handle, originalName: name,
      seriesFile: parsed.seriesFile, seriesFolder: parsed.seriesFolder,
      episodeTag: parsed.episodeTag, episodeName, ext: parsed.ext,
      newName: buildNewFilename(parsed.seriesFile, parsed.episodeTag, parsed.ext, episodeName),
      size, selected: true
    });
  }

  if (tmdbBlocked) els.tmdbBanner.classList.add("show");

  // Sync SRT names to their paired video file
  const videoMap = new Map();
  for (const f of found) if (VIDEO_EXT.has(f.ext)) videoMap.set(`${f.seriesFolder}::${f.episodeTag}`, f.seriesFile);
  for (const f of found){
    if (SUBTITLE_EXT.has(f.ext)){
      const key = `${f.seriesFolder}::${f.episodeTag}`;
      if (videoMap.has(key)){
        f.seriesFile = videoMap.get(key);
        f.newName = buildNewFilename(f.seriesFile, f.episodeTag, f.ext, f.episodeName);
      }
    }
  }

  scannedFiles = found;
  lastScanSeconds = (performance.now() - t0) / 1000;
  await renderScanResults();
  els.scanBtn.disabled = false;
});

async function renderScanResults(){
  els.statTime.textContent = formatDuration(lastScanSeconds);
  els.statFiles.textContent = String(scannedFiles.length);
  els.statSeries.textContent = String(new Set(scannedFiles.map(f => f.seriesFolder)).size);
  els.statSize.textContent = formatSize(scannedFiles.reduce((sum, f) => sum + (f.size || 0), 0));

  if (!scannedFiles.length){
    els.scanResults.innerHTML = "<div class=\"empty-hint\">No recognized video or subtitle files found in the source folder.</div>";
    els.runBtn.disabled = true;
    els.statPending.textContent = "0";
    els.statProcessed.textContent = "0";
    els.statExecTime.textContent = "–";
    return;
  }
  const seriesSet = [...new Set(scannedFiles.map(f => f.seriesFolder))].sort();
  const seriesRows = [];
  for (const s of seriesSet){
    const count = scannedFiles.filter(f => f.seriesFolder === s).length;
    let exists = false;
    try{ await libraryHandle.getDirectoryHandle(s, {create:false}); exists = true; } catch(e){}
    seriesRows.push(`<li><span class="sinfo"><span class="sname">${escapeHtml(s)}</span><span class="scount">${count} ${plural(count, "file")}</span></span>
      <span class="stag ${exists ? "exists" : "newlib"}">${exists ? "Exists in library" : "New"}</span></li>`);
  }

  const episodeGroups = new Map(); // seriesFolder::episodeTag -> files[]
  for (const f of scannedFiles){
    const key = `${f.seriesFolder}::${f.episodeTag}`;
    if (!episodeGroups.has(key)) episodeGroups.set(key, []);
    episodeGroups.get(key).push(f);
  }
  const indexOf = new Map(scannedFiles.map((f,i) => [f,i]));
  const tableRows = [...episodeGroups.values()].map(group => {
    const posterUrl = seriesPosterMap.get(group[0].seriesFolder);
    const thumb = posterUrl
      ? `<img class="row-thumb" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;row-thumb-empty&quot;></span>';">`
      : `<span class="row-thumb-empty"></span>`;
    return group.map((f, idx) => {
      const posterTd = idx === 0
        ? `<td class="poster-cell" rowspan="${group.length}">${thumb}</td>`
        : "";
      const i = indexOf.get(f);
      return `<tr class="${f.selected ? "" : "row-unselected"}" data-idx="${i}"><td class="select-cell"><input type="checkbox" class="row-check" data-idx="${i}" ${f.selected ? "checked" : ""}></td>${posterTd}<td>${breakable(f.originalName)}</td><td class="arrow">→</td><td class="new">${breakable(f.newName)}</td></tr>`;
    }).join("");
  }).join("");

  els.scanResults.innerHTML = `
    <div class="scan-body">
      <div class="series-card">
        <h3>Series in this scan</h3>
        <ul class="series-list">${seriesRows.join("")}</ul>
      </div>
      <div class="results-col">
        <div class="select-toolbar">
          <input type="checkbox" id="selectAllCheck">
          <button class="ghost small" id="selectAllBtn">Select all</button>
          <button class="ghost small" id="selectNoneBtn">Select none</button>
          <span class="select-count" id="selectCount"></span>
        </div>
        <div class="table-scroll">
        <table>
          <colgroup>
            <col style="width:34px">
            <col style="width:100px">
            <col style="width:50%">
            <col style="width:40px">
            <col style="width:50%">
          </colgroup>
          <thead><tr><th class="select-cell"></th><th></th><th>Original file</th><th></th><th>New name</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        </div>
      </div>
    </div>`;
  els.runBtn.disabled = false;
  els.log.style.display = "none";
  els.log.innerHTML = "";
  els.logEmpty.style.display = "block";
  els.summary.textContent = "";
  updateSelectionUI();
}

function selectedFiles(){
  return scannedFiles.filter(f => f.selected);
}
function updateSelectionUI(){
  const total = scannedFiles.length;
  const selected = selectedFiles().length;
  const selectAllCheck = document.getElementById("selectAllCheck");
  const selectCount = document.getElementById("selectCount");
  if (selectAllCheck){
    selectAllCheck.checked = selected === total && total > 0;
    selectAllCheck.indeterminate = selected > 0 && selected < total;
  }
  if (selectCount) selectCount.textContent = `${selected} of ${total} ${plural(total, "file")} selected`;
  els.runBtn.disabled = selected === 0;
  els.statPending.textContent = String(selected);
  els.statProcessed.textContent = "0";
  els.statExecTime.textContent = "–";
}

els.scanResults.addEventListener("change", (e) => {
  if (e.target.classList.contains("row-check")){
    const i = parseInt(e.target.dataset.idx, 10);
    scannedFiles[i].selected = e.target.checked;
    e.target.closest("tr").classList.toggle("row-unselected", !e.target.checked);
    updateSelectionUI();
  } else if (e.target.id === "selectAllCheck"){
    const check = e.target.checked;
    for (const f of scannedFiles) f.selected = check;
    els.scanResults.querySelectorAll(".row-check").forEach(cb => cb.checked = check);
    els.scanResults.querySelectorAll("tbody tr").forEach(tr => tr.classList.toggle("row-unselected", !check));
    updateSelectionUI();
  }
});
els.scanResults.addEventListener("click", (e) => {
  if (e.target.id === "selectAllBtn" || e.target.id === "selectNoneBtn"){
    const check = e.target.id === "selectAllBtn";
    for (const f of scannedFiles) f.selected = check;
    els.scanResults.querySelectorAll(".row-check").forEach(cb => cb.checked = check);
    els.scanResults.querySelectorAll("tbody tr").forEach(tr => tr.classList.toggle("row-unselected", !check));
    updateSelectionUI();
  }
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
els.runBtn.addEventListener("click", async () => {
  const toProcess = selectedFiles();
  if (!toProcess.length) return;
  if (!confirm(`Move and rename ${toProcess.length} ${plural(toProcess.length, "file")}? This will move the original ${plural(toProcess.length, "file")} (not copy ${toProcess.length === 1 ? "it" : "them"}).`)) return;

  els.runBtn.disabled = true;
  els.log.innerHTML = ""; els.log.style.display = "none"; els.logEmpty.style.display = "block";
  els.summary.textContent = "";
  const total = toProcess.length;
  els.statPending.textContent = String(total);
  els.statProcessed.textContent = "0";
  els.statExecTime.textContent = "–";

  let success = 0;
  const errors = [];
  const runStart = performance.now();
  const execTimer = setInterval(() => {
    els.statExecTime.textContent = formatDuration((performance.now() - runStart) / 1000);
  }, 100);

  const updateExecStats = () => {
    els.statProcessed.textContent = String(success);
    els.statPending.textContent = String(total - success - errors.length);
  };

  let useHelper = false;
  const helperSrcRoot = els.helperSourcePath.value.trim();
  const helperLibRoot = els.helperLibraryPath.value.trim();
  if (els.helperCheck.checked){
    if (helperSrcRoot && helperLibRoot){
      useHelper = await pingHelper();
      if (!useHelper) logLineHTML(`⚠ Local helper enabled but not reachable — using the browser for this run instead.`, "warn");
    } else {
      logLineHTML(`⚠ Local helper enabled but the source/library paths aren't set — using the browser for this run instead.`, "warn");
    }
  }

  for (const f of toProcess){
    try{
      // Resolve straight to the final library destination — no local staging
      // folder, so every file's bytes are read and written exactly once.
      const { dirHandle, situation, relDir } = await resolveLibraryDest(libraryHandle, f.seriesFolder, f.episodeTag);

      let destExists = false;
      try{ await dirHandle.getFileHandle(f.newName, {create:false}); destExists = true; } catch(e){}
      if (destExists){
        logLineHTML(`⚠ Already exists in library, skipped: ${breakable(f.newName)}`, "warn");
        errors.push(f.originalName);
        updateExecStats();
        continue;
      }

      logLineHTML(`${VIDEO_EXT.has(f.ext) ? "🎬" : "📄"} ${breakable(f.originalName)}  [${situation}]`, "cyan");
      const pr = progressRow();
      if (useHelper){
        const srcPath = joinPath(helperSrcRoot, f.originalName);
        const destPath = joinPath(helperLibRoot, ...relDir, f.newName);
        await moveFileViaHelper(srcPath, destPath,
          (copied, total, start, instant) => pr.update(copied, total, start, instant));
      } else {
        await moveFile(sourceHandle, f.originalName, dirHandle, f.newName,
          (copied, total, start, instant) => pr.update(copied, total, start, instant));
      }
      success += 1;
      updateExecStats();
    } catch(e){
      logLineHTML(`✗ Error processing ${breakable(f.originalName)}: ${escapeHtml(String(e.message || e))}`, "err");
      errors.push(f.originalName);
      updateExecStats();
    }
  }

  clearInterval(execTimer);
  const elapsedSeconds = (performance.now() - runStart) / 1000;
  els.statExecTime.textContent = formatDuration(elapsedSeconds);

  logLine("", "");
  logLine(`Done: ${success} ${plural(success, "file")} processed successfully, ${errors.length} ${plural(errors.length, "error/skip", "errors/skipped")}.`, success && !errors.length ? "ok" : "dim");
  els.summary.textContent = `${success} succeeded · ${errors.length} ${plural(errors.length, "error/skip", "errors/skipped")}`;
  els.runBtn.disabled = false;
});
