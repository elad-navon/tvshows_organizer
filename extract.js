"use strict";

// ---------------------------------------------------------------------------
// "Extract subtitles" tab: saves a folder's embedded subtitle tracks as .srt
// files next to their videos. The work runs in the local helper (helper.py →
// ffprobe / ffmpeg), since a page can't launch programs; this file lists the
// tracks, keeps the selection, starts the job and streams its log.
// Loaded after app.js — uses its HELPER_BASE, pingHelper, helperProblemText,
// formatDuration, escapeHtml, breakable and safeSetItem.
// ---------------------------------------------------------------------------
(function(){
  const $ = id => document.getElementById(id);
  const x = {
    view: $("extractView"), folder: $("exFolderInput"),
    helperDot: $("exHelperDot"), helperStatus: $("exHelperStatus"), helperStart: $("exHelperStartBtn"),
    scanBtn: $("exScanBtn"), scanErr: $("exScanErrBanner"), scanResults: $("exScanResults"),
    videos: $("exStatVideos"), tracks: $("exStatTracks"), tracksLabel: $("exStatTracksLabel"), scanTime: $("exStatScanTime"),
    runBtn: $("exRunBtn"), runLabel: $("exRunLabel"), stopBtn: $("exStopBtn"), rtl: $("exRtlCheck"), err: $("exErrBanner"),
    pending: $("exStatPending"), extracted: $("exStatExtracted"), failed: $("exStatFailed"), time: $("exStatTime"),
    log: $("exLog"), logEmpty: $("exLogEmpty"), clearLogBtn: $("exClearLogBtn"),
  };
  if (!x.runBtn) return;

  const POLL_MS = 700;
  const LANG_NAMES = {
    en: "English", he: "Hebrew", fr: "French", de: "German", es: "Spanish", it: "Italian", ru: "Russian",
    ar: "Arabic", pt: "Portuguese", nl: "Dutch", sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
    pl: "Polish", tr: "Turkish", el: "Greek", hu: "Hungarian", cs: "Czech", ro: "Romanian", ja: "Japanese",
    ko: "Korean", zh: "Chinese", und: "Unknown language",
  };
  const CODEC_NAMES = {
    subrip: "SRT", ass: "ASS", ssa: "SSA", mov_text: "MP4 text", webvtt: "WebVTT", text: "text",
    hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub", dvb_subtitle: "DVB",
  };
  const langName = l => LANG_NAMES[l] || l;

  let jobId = null;
  let scanned = null;        // {folder, videos: [{video, tracks, error}]}
  const selected = new Set(); // "video\0index"
  const key = (video, index) => `${video}\u0000${index}`;
  const eligible = t => !t.problem && !t.exists;

  // ------------------------------------------------------------- shared bits
  const nowClock = () => new Date().toTimeString().slice(0, 8);
  function log(time, text, cls){
    x.logEmpty.style.display = "none";
    x.log.style.display = "block";
    const row = document.createElement("div");
    row.className = "row" + (cls && cls !== "info" ? " " + cls : "");
    row.innerHTML = `<span class="dim">[${escapeHtml(time)}]</span> ${escapeHtml(text)}`;
    x.log.appendChild(row);
    x.log.scrollTop = x.log.scrollHeight;
  }
  function showError(msg, el = x.err){
    if (msg){ el.textContent = msg; el.classList.add("show"); }
    else { el.textContent = ""; el.classList.remove("show"); }
  }
  function clearLog(){
    x.log.innerHTML = ""; x.log.style.display = "none"; x.logEmpty.style.display = "block";
  }
  x.clearLogBtn.addEventListener("click", clearLog);

  function readSetting(name, fallback){
    try { const v = localStorage.getItem(name); return v === null ? fallback : v; } catch(e){ return fallback; }
  }

  const folderPath = () => x.folder.value.trim().replace(/^"(.*)"$/, "$1");
  x.folder.value = readSetting("extractFolder", readSetting("autosyncFolder", ""));
  x.folder.addEventListener("input", () => {
    safeSetItem("extractFolder", x.folder.value.trim());
    // A scan only vouches for the folder it was run on.
    if (scanned){
      scanned = null;
      selected.clear();
      resetScanStats();
      x.scanResults.innerHTML = `<div class="empty-hint">Folder changed — scan again.</div>`;
    }
    updateRunButton();
  });

  x.rtl.checked = readSetting("extractRtlFix", "1") !== "0";
  x.rtl.addEventListener("change", () => safeSetItem("extractRtlFix", x.rtl.checked ? "1" : "0"));

  // Languages picked last time are picked again on the next scan.
  function wantedLangs(){
    try { const v = JSON.parse(readSetting("extractLangs", "")); if (Array.isArray(v)) return new Set(v); } catch(e){}
    return new Set(["en", "he"]);
  }
  function saveLangs(){
    if (!scanned) return;
    const langs = new Set();
    for (const v of scanned.videos) for (const t of v.tracks) if (selected.has(key(v.video, t.index))) langs.add(t.lang);
    safeSetItem("extractLangs", JSON.stringify([...langs]));
  }

  async function refreshHelper(){
    const state = await pingHelper();
    x.helperDot.className = state === "ok" ? "dot ok" : "dot warn";
    x.helperStatus.textContent = state === "ok" ? "Helper connected" : helperProblemText(state);
    showHelperStart(x.helperStart, state);
    return state;
  }
  wireHelperStart(x.helperStart, x.helperStatus, refreshHelper);
  refreshHelper();
  setInterval(() => { if (!x.view.hidden && !jobId) refreshHelper(); }, 20000);
  document.getElementById("tabExtractBtn").addEventListener("click", () => { if (!jobId) refreshHelper(); });

  function updateRunButton(){
    const n = selected.size;
    x.runBtn.disabled = !!jobId || !scanned || !n;
    x.runLabel.textContent = n ? `Extract ${n} track${n === 1 ? "" : "s"}` : "Extract";
  }
  function setRunning(on){
    x.scanBtn.disabled = on;
    x.folder.disabled = on;
    x.stopBtn.disabled = !on;
    for (const el of x.scanResults.querySelectorAll("input")) el.disabled = on || el.dataset.locked === "1";
    updateRunButton();
  }
  function updateTiles(d){
    x.pending.textContent = Math.max(0, d.total - d.extracted - d.failed - d.skipped);
    x.extracted.textContent = d.extracted;
    x.failed.textContent = d.failed + d.skipped;
  }
  function resetScanStats(){
    x.videos.textContent = "0"; x.tracks.textContent = "0";
    x.tracksLabel.textContent = "Subtitle tracks"; x.scanTime.textContent = "0s";
  }

  // -------------------------------------------------------------- Scan view
  function trackLabel(t){
    const bits = [`#${t.index}`, langName(t.lang), CODEC_NAMES[t.codec] || t.codec];
    if (t.forced) bits.push("forced");
    if (t.sdh) bits.push("SDH");
    if (t.default) bits.push("default");
    let text = escapeHtml(bits.join(" · "));
    if (t.title) text += ` <span class="dim">“${escapeHtml(t.title)}”</span>`;
    return text;
  }

  function renderScan(){
    const { videos } = scanned;
    const all = videos.flatMap(v => v.tracks);
    const usable = all.filter(eligible).length;
    x.videos.textContent = String(videos.length);
    x.tracks.textContent = String(all.length);
    x.tracksLabel.textContent = `Subtitle tracks (${usable} can be extracted)`;
    if (!videos.length){
      x.scanResults.innerHTML = `<div class="empty-hint">No video files found in this folder.</div>`;
      return;
    }

    // One checkbox per language: picks that language's tracks in every episode.
    const langs = new Map();
    for (const v of videos) for (const t of v.tracks) if (eligible(t)) langs.set(t.lang, (langs.get(t.lang) || 0) + 1);
    const chips = [...langs].sort((p, q) => q[1] - p[1])
      .map(([l, n]) => `<label><input type="checkbox" class="row-check" data-lang="${escapeHtml(l)}"> ${escapeHtml(langName(l))} (${n})</label>`)
      .join("");

    const rows = videos.map((v, vi) => {
      if (v.error) return `<tr><td></td><td>${breakable(v.video)}</td><td class="skip" colspan="3">✗ ${escapeHtml(v.error)}</td></tr>`;
      if (!v.tracks.length) return `<tr><td></td><td>${breakable(v.video)}</td><td class="skip" colspan="3">No subtitle tracks inside</td></tr>`;
      return v.tracks.map((t, i) => {
        const id = `ex-${vi}-${t.index}`;
        const ok = eligible(t);
        const target = t.problem ? `<td class="skip">${escapeHtml(t.problem)}</td>`
          : t.exists ? `<td class="skip">${breakable(t.target)} — already exists</td>`
          : `<td class="new">${breakable(t.target)}</td>`;
        return `<tr${ok ? "" : ' style="opacity:.6"'}>
          <td class="select-cell"><input type="checkbox" class="row-check" id="${id}" data-video="${escapeHtml(v.video)}" data-index="${t.index}"${ok ? "" : ' disabled data-locked="1"'}></td>
          <td>${i === 0 ? breakable(v.video) : ""}</td>
          <td><label for="${id}" style="cursor:${ok ? "pointer" : "default"}">${trackLabel(t)}</label></td>
          <td class="arrow">→</td>${target}</tr>`;
      }).join("");
    }).join("");

    x.scanResults.innerHTML = `
      ${usable ? `<div class="actions" style="margin-top:18px;"><span class="status-text">Languages:</span>${chips}</div>`
               : `<div class="empty-hint" style="margin-top:14px;">No text subtitle tracks to extract.</div>`}
      <div class="table-scroll" style="margin-top:14px;">
      <table>
        <colgroup><col style="width:34px"><col style="width:36%"><col style="width:30%"><col style="width:40px"><col style="width:34%"></colgroup>
        <thead><tr><th class="select-cell"></th><th>Video file</th><th>Track</th><th></th><th>Saved as</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>`;
    syncChecks();
  }

  // Reflects `selected` in the track and language checkboxes.
  function syncChecks(){
    for (const el of x.scanResults.querySelectorAll("input[data-index]")){
      el.checked = selected.has(key(el.dataset.video, Number(el.dataset.index)));
    }
    for (const el of x.scanResults.querySelectorAll("input[data-lang]")){
      const ts = scanned.videos.flatMap(v => v.tracks.filter(t => t.lang === el.dataset.lang && eligible(t)).map(t => key(v.video, t.index)));
      const on = ts.filter(k => selected.has(k)).length;
      el.checked = on > 0 && on === ts.length;
      el.indeterminate = on > 0 && on < ts.length;
    }
    updateRunButton();
  }

  x.scanResults.addEventListener("change", e => {
    const el = e.target;
    if (!scanned || !(el instanceof HTMLInputElement)) return;
    if (el.dataset.lang){
      for (const v of scanned.videos) for (const t of v.tracks){
        if (t.lang !== el.dataset.lang || !eligible(t)) continue;
        // Forced tracks only carry the foreign-language bits; picked one by one.
        if (el.checked && t.forced) continue;
        if (el.checked) selected.add(key(v.video, t.index)); else selected.delete(key(v.video, t.index));
      }
    } else if (el.dataset.index !== undefined){
      const k = key(el.dataset.video, Number(el.dataset.index));
      if (el.checked) selected.add(k); else selected.delete(k);
    } else return;
    syncChecks();
    saveLangs();
  });

  // afterRun: the re-scan after an extraction, which keeps the log and tiles.
  async function scan(afterRun = false){
    showError("", x.scanErr);
    const folder = folderPath();
    if (!folder){ showError("Enter the folder path first (e.g. C:\\Elad\\TV).", x.scanErr); return; }

    scanned = null;
    selected.clear();
    x.scanBtn.disabled = true;
    updateRunButton();
    x.scanResults.innerHTML = `<div class="empty-hint">Reading the videos…</div>`;
    resetScanStats();
    const t0 = performance.now();
    try{
      const state = await refreshHelper();
      if (state !== "ok") throw new Error(helperProblemText(state));
      const res = await fetch(`${HELPER_BASE}/extract/scan`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }),
      });
      const d = await res.json().catch(() => ({}));
      // A route-level 404 means the running helper predates this endpoint.
      if (res.status === 404 && d.error === "not found"){
        throw new Error("the running helper is an older version — close its window and run start_helper.bat again");
      }
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      scanned = { folder, videos: d.videos };
      // Default pick: last time's languages, full tracks only (not forced).
      // After a run nothing is picked: what's left was deliberately left out.
      const langs = afterRun ? new Set() : wantedLangs();
      for (const v of scanned.videos) for (const t of v.tracks){
        if (eligible(t) && !t.forced && langs.has(t.lang)) selected.add(key(v.video, t.index));
      }
      x.scanTime.textContent = formatDuration((performance.now() - t0) / 1000);
      renderScan();
      if (!afterRun){
        clearLog();
        updateTiles({ total: selected.size, extracted: 0, failed: 0, skipped: 0 });
        x.time.textContent = "–";
      }
    } catch(e){
      x.scanResults.innerHTML = "";
      showError(`Scan failed: ${e.message}`, x.scanErr);
    }
    x.scanBtn.disabled = false;
    updateRunButton();
  }
  x.scanBtn.addEventListener("click", () => scan());

  // ------------------------------------------------------------- Extract
  x.runBtn.addEventListener("click", async () => {
    showError("");
    if (!scanned || !selected.size) return;
    const folder = scanned.folder;
    const items = scanned.videos
      .map(v => ({ video: v.video, streams: v.tracks.filter(t => selected.has(key(v.video, t.index))).map(t => t.index) }))
      .filter(i => i.streams.length);

    clearLog();
    jobId = "starting";
    setRunning(true);
    x.time.textContent = "–";
    updateTiles({ total: 0, extracted: 0, failed: 0, skipped: 0 });
    let start;
    try{
      const state = await refreshHelper();
      if (state !== "ok") throw new Error(helperProblemText(state));
      const res = await fetch(`${HELPER_BASE}/extract`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, items, rtlFix: x.rtl.checked }),
      });
      start = await res.json().catch(() => ({}));
      if (res.status === 404 && start.error === "not found"){
        throw new Error("the running helper is an older version — close its window and run start_helper.bat again");
      }
      if (!res.ok || !start.ok || !start.job) throw new Error(start.error || `HTTP ${res.status}`);
    } catch(e){
      showError(`Couldn't start the extraction: ${e.message}`);
      jobId = null;
      setRunning(false);
      return;
    }

    jobId = start.job;
    const t0 = performance.now();
    let since = 0, failures = 0;
    while (true){
      await new Promise(r => setTimeout(r, POLL_MS));
      let d;
      try{
        const res = await fetch(`${HELPER_BASE}/extract/progress?job=${encodeURIComponent(jobId)}&since=${since}`, { cache: "no-store" });
        d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
        failures = 0;
      } catch(e){
        if (++failures < 5) continue;
        log(nowClock(), `✗ Lost contact with the helper (${e.message}). Check its window.`, "err");
        break;
      }
      for (const line of d.log) log(line.time, line.text, line.level);
      since = d.next;
      updateTiles(d);
      if (d.done) break;
    }
    x.time.textContent = formatDuration((performance.now() - t0) / 1000);
    jobId = null;
    // What was just written now exists — re-read the folder so it shows as such.
    selected.clear();
    setRunning(false);
    scan(true);
  });

  x.stopBtn.addEventListener("click", async () => {
    if (!jobId || jobId === "starting") return;
    x.stopBtn.disabled = true;
    log(nowClock(), "Stopping…", "warn");
    try{
      await fetch(`${HELPER_BASE}/extract/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: jobId }),
      });
    } catch(e){
      log(nowClock(), `✗ Couldn't reach the helper to stop (${e.message}).`, "err");
    }
  });
})();
