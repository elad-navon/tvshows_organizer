"use strict";

// ---------------------------------------------------------------------------
// "Shift subtitle timing" tab: a constant shift, or a two-point linear
// correction (offset + scale, e.g. a frame-rate mismatch). Pure arithmetic —
// no network — so a run either fully succeeds or is rejected up front.
// Each tool is applied to the file as originally loaded, never cumulatively.
// ---------------------------------------------------------------------------
const SYNC_SRT = (typeof module !== "undefined" && module.exports) ? require("./srt-utils.js") : globalThis;

// Accepts a signed value in any parseTimestamp format: "1.5", "-2.3",
// "+00:00:01,200", "-01:02,500".
function parseOffset(input){
  const s = String(input == null ? "" : input).trim();
  const m = /^([+-])\s*(\d.*)$/.exec(s);
  if (m){
    const v = SYNC_SRT.parseTimestamp(m[2]);
    return v == null ? null : (m[1] === "-" ? -v : v);
  }
  return SYNC_SRT.parseTimestamp(s);
}

// Shared by both tools. Cues without a parseable timestamp line are left
// untouched and counted. Times pushed below 0 are clamped to 0. A cue whose
// end ends up before its start can only come from the source file itself
// (both tools preserve order), so it's set to zero length and reported.
function remapCues(cues, mapMs){
  let clamped = 0, skipped = 0;
  const inverted = [];
  const out = cues.map((c, i) => {
    const t = SYNC_SRT.parseTimestampLine(c.timestamp);
    if (!t){ skipped++; return c; }
    let start = Math.round(mapMs(t.startMs));
    let end = Math.round(mapMs(t.endMs));
    if (start < 0){ start = 0; clamped++; }
    if (end < 0){ end = 0; clamped++; }
    if (end < start){ end = start; inverted.push(c.index || `#${i + 1}`); }
    return { ...c, timestamp: SYNC_SRT.formatTimestampLine(start, end, t.rest) };
  });
  return { cues: out, clamped, skipped, inverted };
}

function shiftCues(cues, deltaMs){
  return remapCues(cues, t => t + deltaMs);
}

// Anchors: {originalMs, correctedMs}. Blocks on anything that can't be a
// real correction; warns (without blocking) on an implausible scale — real
// frame-rate fixes sit close to 1 (e.g. 25/23.976 ≈ 1.0427).
function validateAnchors(a1, a2){
  const vals = [a1.originalMs, a1.correctedMs, a2.originalMs, a2.correctedMs];
  if (vals.some(v => v == null || !Number.isFinite(v))) return { error: "One of the four times couldn't be read. Use hh:mm:ss,ms or seconds." };
  if (vals.some(v => v < 0)) return { error: "Anchor times can't be negative." };
  if (a1.originalMs === a2.originalMs) return { error: "The two original times must be different." };
  const scale = (a2.correctedMs - a1.correctedMs) / (a2.originalMs - a1.originalMs);
  if (!Number.isFinite(scale) || scale <= 0){
    return { error: "These anchors would reverse or freeze time. The later original time must map to a later corrected time." };
  }
  if (scale < 0.5 || scale > 2){
    return { scale, warning: `Unusual scale factor (×${scale.toFixed(4)}). Real frame-rate fixes are usually close to ×1.0 — check the anchor times.` };
  }
  return { scale };
}

function linearCorrectCues(cues, a1, scale){
  return remapCues(cues, t => a1.correctedMs + (t - a1.originalMs) * scale);
}

// Keeps a trailing language tag last so players still detect it:
// "Show.S01E01.he.srt" -> "Show.S01E01.synced.he.srt". Language tags are
// lowercase by convention, which keeps a Title-Case episode name like ".Run"
// from being mistaken for one.
function syncedOutputName(sourceName){
  const stem = SYNC_SRT.srtStem(sourceName).replace(/\.synced(?=(\.[a-z]{2,3})?$)/, "");
  const m = /^(.*?)(\.[a-z]{2,3})$/.exec(stem);
  return m ? `${m[1]}.synced${m[2]}.srt` : `${stem}.synced.srt`;
}

// ---------------------------------------------------------------------------
// UI wiring (browser only)
// ---------------------------------------------------------------------------
if (typeof document !== "undefined") (function(){
  const $ = id => document.getElementById(id);
  const s = {
    fileInput: $("syncFileInput"), fileBtn: $("syncFileBtn"), fileName: $("syncFileName"),
    fileDot: $("syncFileDot"), fileStatus: $("syncFileStatus"),
    shiftInput: $("syncShiftInput"), shiftBtn: $("syncShiftBtn"),
    a1o: $("syncA1Orig"), a1n: $("syncA1New"), a2o: $("syncA2Orig"), a2n: $("syncA2New"),
    linearBtn: $("syncLinearBtn"),
    warn: $("syncWarnBanner"), err: $("syncErrBanner"),
    log: $("syncLog"), logEmpty: $("syncLogEmpty"), clearLogBtn: $("syncClearLogBtn"),
    downloadBtn: $("syncDownloadBtn"), downloadLabel: $("syncDownloadLabel"),
  };
  if (!s.shiftBtn) return;

  const esc = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function log(html, cls){
    s.logEmpty.style.display = "none";
    s.log.style.display = "block";
    const row = document.createElement("div");
    row.className = "row" + (cls ? " " + cls : "");
    row.innerHTML = html;
    s.log.appendChild(row);
    s.log.scrollTop = s.log.scrollHeight;
  }
  s.clearLogBtn.addEventListener("click", () => {
    s.log.innerHTML = ""; s.log.style.display = "none"; s.logEmpty.style.display = "block";
  });
  function banner(el, html){
    if (html){ el.innerHTML = html; el.classList.add("show"); }
    else { el.innerHTML = ""; el.classList.remove("show"); }
  }

  let source = null; // {name, cues, malformed}
  let output = null; // {name, text}

  function setEnabled(on){ s.shiftBtn.disabled = !on; s.linearBtn.disabled = !on; }
  setEnabled(false);

  s.fileBtn.addEventListener("click", () => s.fileInput.click());
  s.fileInput.addEventListener("change", async () => {
    const file = s.fileInput.files[0];
    s.fileInput.value = "";
    if (!file) return;
    source = null; output = null;
    s.downloadBtn.hidden = true;
    banner(s.warn, ""); banner(s.err, "");
    setEnabled(false);
    s.fileName.textContent = file.name;
    s.fileName.classList.remove("empty");
    if (file.size > 10 * 1024 * 1024){
      s.fileDot.className = "dot warn";
      s.fileStatus.textContent = "File is too large to be a subtitle file";
      return;
    }
    const { text, encoding } = SYNC_SRT.decodeSubtitleBytes(await file.arrayBuffer(), "windows-1255");
    const parsed = SYNC_SRT.parseSrt(text);
    const timed = parsed.cues.filter(c => SYNC_SRT.parseTimestampLine(c.timestamp)).length;
    if (!timed){
      s.fileDot.className = "dot warn";
      s.fileStatus.textContent = "No subtitle timestamps found — is this an .srt file?";
      return;
    }
    source = { name: file.name, cues: parsed.cues, malformed: parsed.malformed };
    s.fileDot.className = "dot ok";
    s.fileStatus.textContent = `${timed} cues` + (parsed.malformed ? ` · ${parsed.malformed} malformed block(s) will be left unchanged` : "")
      + (encoding !== "UTF-8" ? ` · read as ${encoding} (saved as UTF-8)` : "");
    setEnabled(true);
  });

  function finish(res, description){
    if (res.cues.length !== source.cues.length){
      banner(s.err, "The output failed an integrity check (cue count changed). Nothing was downloaded.");
      return;
    }
    const text = SYNC_SRT.stringifySrt(res.cues);
    output = { name: syncedOutputName(source.name), text };
    log(`📄 ${esc(source.name)}`, "cyan");
    log(`✓ ${esc(description)} — ${res.cues.length - res.skipped} cues retimed`, "ok");
    if (res.skipped) log(`⚠ ${res.skipped} block(s) without a valid timestamp were left unchanged`, "warn");
    if (res.clamped) log(`⚠ ${res.clamped} time(s) fell before 00:00:00 and were set to 0`, "warn");
    if (res.inverted.length){
      const list = res.inverted.slice(0, 15).join(", ") + (res.inverted.length > 15 ? ", …" : "");
      log(`⚠ ${res.inverted.length} cue(s) already ended before they started in the source file (cues: ${esc(list)}) — set to zero length`, "warn");
    }
    s.downloadLabel.textContent = `Download ${output.name}`;
    s.downloadBtn.hidden = false;
  }

  s.shiftBtn.addEventListener("click", () => {
    if (!source) return;
    banner(s.warn, ""); banner(s.err, "");
    const delta = parseOffset(s.shiftInput.value);
    if (delta == null){ banner(s.err, "Enter the shift in seconds (e.g. 1.5 or -2.3) or as hh:mm:ss,ms with a + or - sign."); return; }
    if (delta === 0){ banner(s.err, "A shift of 0 wouldn't change anything."); return; }
    const sign = delta > 0 ? "+" : "−";
    finish(shiftCues(source.cues, delta), `Shifted by ${sign}${(Math.abs(delta) / 1000).toFixed(3)}s (${delta > 0 ? "later" : "earlier"})`);
  });

  s.linearBtn.addEventListener("click", () => {
    if (!source) return;
    banner(s.warn, ""); banner(s.err, "");
    const a1 = { originalMs: SYNC_SRT.parseTimestamp(s.a1o.value), correctedMs: SYNC_SRT.parseTimestamp(s.a1n.value) };
    const a2 = { originalMs: SYNC_SRT.parseTimestamp(s.a2o.value), correctedMs: SYNC_SRT.parseTimestamp(s.a2n.value) };
    const v = validateAnchors(a1, a2);
    if (v.error){ banner(s.err, esc(v.error)); return; }
    if (v.warning){
      banner(s.warn, esc(v.warning));
      if (!confirm(`${v.warning}\n\nApply it anyway?`)) return;
    }
    finish(linearCorrectCues(source.cues, a1, v.scale), `Linear correction applied (scale ×${v.scale.toFixed(4)})`);
  });

  s.downloadBtn.addEventListener("click", () => {
    if (output) SYNC_SRT.downloadTextFile(output.name, output.text);
  });
})();

if (typeof module !== "undefined" && module.exports){
  module.exports = { parseOffset, remapCues, shiftCues, validateAnchors, linearCorrectCues, syncedOutputName };
}
