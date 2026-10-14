"use strict";

// ---------------------------------------------------------------------------
// "Auto Sync" tab: aligns every subtitle in a folder to its episode's audio.
// The work runs in the local helper (helper.py → ffsubsync), since a page
// can't launch programs; this file only starts the job and streams its log.
// Loaded after app.js — uses its HELPER_BASE, pingHelper, helperProblemText,
// formatDuration, escapeHtml, breakable and safeSetItem.
// ---------------------------------------------------------------------------
(function(){
  const $ = id => document.getElementById(id);
  const a = {
    view: $("autosyncView"), folder: $("asFolderInput"),
    helperDot: $("asHelperDot"), helperStatus: $("asHelperStatus"),
    scanBtn: $("asScanBtn"), scanErr: $("asScanErrBanner"), scanResults: $("asScanResults"),
    found: $("asStatFound"), foundLabel: $("asStatFoundLabel"), skipped: $("asStatSkipped"), scanTime: $("asStatScanTime"),
    runBtn: $("asRunBtn"), stopBtn: $("asStopBtn"), err: $("asErrBanner"),
    pending: $("asStatPending"), synced: $("asStatSynced"), failed: $("asStatFailed"), time: $("asStatTime"),
    log: $("asLog"), logEmpty: $("asLogEmpty"), clearLogBtn: $("asClearLogBtn"),
  };
  if (!a.runBtn) return;

  const POLL_MS = 1000;
  let jobId = null;
  let scanned = null; // {folder, pairs, skipped} from the last scan of the current path

  const nowClock = () => new Date().toTimeString().slice(0, 8);
  function log(time, text, cls){
    a.logEmpty.style.display = "none";
    a.log.style.display = "block";
    const row = document.createElement("div");
    row.className = "row" + (cls && cls !== "info" ? " " + cls : "");
    row.innerHTML = `<span class="dim">[${escapeHtml(time)}]</span> ${escapeHtml(text)}`;
    a.log.appendChild(row);
    a.log.scrollTop = a.log.scrollHeight;
  }
  function showError(msg, el = a.err){
    if (msg){ el.textContent = msg; el.classList.add("show"); }
    else { el.textContent = ""; el.classList.remove("show"); }
  }
  function clearLog(){
    a.log.innerHTML = ""; a.log.style.display = "none"; a.logEmpty.style.display = "block";
  }
  a.clearLogBtn.addEventListener("click", clearLog);

  const folderPath = () => a.folder.value.trim().replace(/^"(.*)"$/, "$1");
  a.folder.value = localStorage.getItem("autosyncFolder") || "";
  a.folder.addEventListener("input", () => {
    safeSetItem("autosyncFolder", a.folder.value.trim());
    // A scan only vouches for the folder it was run on.
    if (scanned){
      scanned = null;
      resetScanStats();
      a.scanResults.innerHTML = `<div class="empty-hint">Folder changed — scan again.</div>`;
    }
    a.runBtn.disabled = true;
  });

  async function refreshHelper(){
    const state = await pingHelper();
    a.helperDot.className = state === "ok" ? "dot ok" : "dot warn";
    a.helperStatus.textContent = state === "ok" ? "Helper connected" : helperProblemText(state);
    return state;
  }
  // While this tab is open, keep the status honest — and the helper from
  // idling out (it shuts down after a stretch with no requests).
  refreshHelper();
  setInterval(() => { if (!a.view.hidden && !jobId) refreshHelper(); }, 20000);
  document.getElementById("tabAutosyncBtn").addEventListener("click", () => { if (!jobId) refreshHelper(); });

  function setRunning(on){
    a.runBtn.disabled = on || !(scanned && scanned.pairs.length);
    a.scanBtn.disabled = on;
    a.folder.disabled = on;
    a.stopBtn.disabled = !on;
  }
  function updateTiles(d){
    a.pending.textContent = Math.max(0, d.total - d.synced - d.failed);
    a.synced.textContent = d.synced;
    a.failed.textContent = d.failed;
  }
  function resetScanStats(){
    a.found.textContent = "0"; a.foundLabel.textContent = "Files found";
    a.skipped.textContent = "0"; a.scanTime.textContent = "0s";
  }

  // -------------------------------------------------------------- Scan
  function renderScan(){
    const { pairs, skipped, videoCount, subtitleCount } = scanned;
    a.found.textContent = String(videoCount + subtitleCount);
    a.foundLabel.textContent = `Files found (${videoCount} video, ${subtitleCount} subtitle)`;
    a.skipped.textContent = String(skipped.length);
    if (!pairs.length && !skipped.length){
      a.scanResults.innerHTML = `<div class="empty-hint">No video files found in this folder.</div>`;
      return;
    }
    const rows = [
      ...pairs.map(p => ({ video: p.video, html: `<td class="new">${breakable(p.srt)}</td>` })),
      ...skipped.map(s => ({ video: s.video, html: `<td class="skip">⚠ ${escapeHtml(s.reason)}</td>` })),
    ].sort((x, y) => x.video.localeCompare(y.video))
     .map(r => `<tr><td>${breakable(r.video)}</td><td class="arrow">→</td>${r.html}</tr>`).join("");
    a.scanResults.innerHTML = `
      ${pairs.length ? "" : `<div class="empty-hint">None of the videos has a matching subtitle — nothing to sync.</div>`}
      <div class="table-scroll" style="margin-top:20px;">
      <table>
        <colgroup><col style="width:50%"><col style="width:40px"><col style="width:50%"></colgroup>
        <thead><tr><th>Video file</th><th></th><th>Subtitle</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>`;
  }

  a.scanBtn.addEventListener("click", async () => {
    showError("", a.scanErr);
    const folder = folderPath();
    if (!folder){ showError("Enter the folder path first (e.g. C:\\Elad\\TV).", a.scanErr); return; }

    scanned = null;
    setRunning(false);
    a.scanBtn.disabled = true;
    a.scanResults.innerHTML = `<div class="empty-hint">Scanning…</div>`;
    resetScanStats();
    const t0 = performance.now();
    try{
      const state = await refreshHelper();
      if (state !== "ok") throw new Error(helperProblemText(state));
      const res = await fetch(`${HELPER_BASE}/autosync/scan`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }),
      });
      const d = await res.json().catch(() => ({}));
      // A route-level 404 means the running helper predates this endpoint.
      if (res.status === 404 && d.error === "not found"){
        throw new Error("the running helper is an older version — close its window and run start_helper.bat again");
      }
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      scanned = { folder, pairs: d.pairs, skipped: d.skipped, videoCount: d.videoCount, subtitleCount: d.subtitleCount };
      a.scanTime.textContent = formatDuration((performance.now() - t0) / 1000);
      renderScan();
      // Same as Organize: a fresh scan starts a fresh run.
      clearLog();
      updateTiles({ total: scanned.pairs.length, synced: 0, failed: 0 });
      a.time.textContent = "–";
    } catch(e){
      a.scanResults.innerHTML = "";
      showError(`Scan failed: ${e.message}`, a.scanErr);
    }
    setRunning(false);
  });

  // -------------------------------------------------------------- Sync
  a.runBtn.addEventListener("click", async () => {
    showError("");
    if (!scanned) return;
    const folder = scanned.folder;

    clearLog();
    setRunning(true);
    a.time.textContent = "–";
    updateTiles({ total: 0, synced: 0, failed: 0 });
    const state = await refreshHelper();
    if (state !== "ok"){ showError(helperProblemText(state) + "."); setRunning(false); return; }

    let start;
    try{
      const res = await fetch(`${HELPER_BASE}/autosync`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }),
      });
      start = await res.json().catch(() => ({}));
      if (!res.ok || !start.ok || !start.job) throw new Error(start.error || `HTTP ${res.status}`);
    } catch(e){
      showError(`Couldn't start the sync: ${e.message}`);
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
        const res = await fetch(`${HELPER_BASE}/autosync/progress?job=${encodeURIComponent(jobId)}&since=${since}`, { cache: "no-store" });
        d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
        failures = 0;
      } catch(e){
        // A missed poll or two is harmless; a helper that's gone isn't.
        if (++failures < 5) continue;
        log(nowClock(), `✗ Lost contact with the helper (${e.message}). Check its window.`, "err");
        break;
      }
      for (const line of d.log) log(line.time, line.text, line.level);
      since = d.next;
      updateTiles(d);
      if (d.done) break;
    }
    a.time.textContent = formatDuration((performance.now() - t0) / 1000);
    jobId = null;
    setRunning(false);
  });

  a.stopBtn.addEventListener("click", async () => {
    if (!jobId) return;
    a.stopBtn.disabled = true;
    log(nowClock(), "Stopping…", "warn");
    try{
      await fetch(`${HELPER_BASE}/autosync/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: jobId }),
      });
    } catch(e){
      log(nowClock(), `✗ Couldn't reach the helper to stop (${e.message}).`, "err");
    }
  });
})();
