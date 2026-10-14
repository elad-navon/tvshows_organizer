"use strict";

// ---------------------------------------------------------------------------
// "Auto Sync" tab: aligns every subtitle in a folder to its episode's audio.
// The work runs in the local helper (helper.py → ffsubsync), since a page
// can't launch programs; this file only starts the job and streams its log.
// Loaded after app.js — uses its HELPER_BASE, pingHelper, helperProblemText,
// formatDuration, escapeHtml and safeSetItem.
// ---------------------------------------------------------------------------
(function(){
  const $ = id => document.getElementById(id);
  const a = {
    view: $("autosyncView"), folder: $("asFolderInput"),
    helperDot: $("asHelperDot"), helperStatus: $("asHelperStatus"),
    runBtn: $("asRunBtn"), stopBtn: $("asStopBtn"), err: $("asErrBanner"),
    pending: $("asStatPending"), synced: $("asStatSynced"), failed: $("asStatFailed"), time: $("asStatTime"),
    log: $("asLog"), logEmpty: $("asLogEmpty"), clearLogBtn: $("asClearLogBtn"),
  };
  if (!a.runBtn) return;

  const POLL_MS = 1000;
  let jobId = null;

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
  function showError(msg){
    if (msg){ a.err.textContent = msg; a.err.classList.add("show"); }
    else { a.err.textContent = ""; a.err.classList.remove("show"); }
  }
  a.clearLogBtn.addEventListener("click", () => {
    a.log.innerHTML = ""; a.log.style.display = "none"; a.logEmpty.style.display = "block";
  });

  a.folder.value = localStorage.getItem("autosyncFolder") || "";
  a.folder.addEventListener("input", () => safeSetItem("autosyncFolder", a.folder.value.trim()));

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
    a.runBtn.disabled = on;
    a.folder.disabled = on;
    a.stopBtn.disabled = !on;
  }
  function updateTiles(d){
    a.pending.textContent = Math.max(0, d.total - d.synced - d.failed);
    a.synced.textContent = d.synced;
    a.failed.textContent = d.failed;
  }

  a.runBtn.addEventListener("click", async () => {
    showError("");
    const folder = a.folder.value.trim().replace(/^"(.*)"$/, "$1");
    if (!folder){ showError("Enter the folder path first (e.g. C:\\Elad\\TV)."); return; }

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
