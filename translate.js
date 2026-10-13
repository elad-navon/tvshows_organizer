"use strict";

// ---------------------------------------------------------------------------
// "Translate subtitles" tab: English .srt -> Hebrew .he.srt, plus the RTL
// punctuation fix ported from rtl_punctuation_fix.py.
//
// Engines, in order:
//  1. translate.googleapis.com/translate_a/single — an UNOFFICIAL, undocumented
//     endpoint with no SLA. It can change, rate-limit or disappear at any time,
//     so every response is validated and every failure is survivable.
//  2. Chrome's on-device Translator API — used for whatever Google didn't
//     translate. Only treated as usable after Translator.availability()
//     actually says so at runtime; never assumed from the browser version.
// ---------------------------------------------------------------------------
const TR_SRT = (typeof module !== "undefined" && module.exports) ? require("./srt-utils.js") : globalThis;

// --- RTL punctuation fix: straight port of rtl_punctuation_fix.py ----------
// Python used re.DOTALL here (JS: the `s` flag) but NOT on the tag regex —
// that asymmetry is kept on purpose.
const TRAILING_PUNCT_RE = /^(.*?)(\s*)([!?,.:;\-…]+)(\s*)$/s;
const TAG_WRAP_RE = /^(<[^>]+>)(.*?)(<\/[^>]+>)?$/;

function fixText(text){
  text = text.trim();
  if (!text) return text;
  const m = TRAILING_PUNCT_RE.exec(text);
  if (m){
    const body = m[1].trim();
    if (body) return m[3] + body;
  }
  return text;
}

function fixLine(line){
  const m = TAG_WRAP_RE.exec(line.trim());
  if (m) return m[1] + fixText(m[2]) + (m[3] || "");
  return fixText(line);
}

// --- Cue <-> translatable units -------------------------------------------
// A cue becomes one unit (its lines joined, for sentence context), except a
// dialogue cue ("- Hi." / "- Hello.") which becomes one unit per speaker so
// the speaker split survives. Markup Google would mangle is lifted out first
// and restored afterwards: a leading {\an8}-style override, and one wrapping
// tag pair such as <i>...</i>. Any other inline tags are dropped.
const LEADING_OVERRIDE_RE = /^(?:\{\\[^}]*\})+/;

function cueToUnits(textLines){
  const lines = textLines.map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  let prefix = "";
  const ov = LEADING_OVERRIDE_RE.exec(lines[0]);
  if (ov){ prefix = ov[0]; lines[0] = lines[0].slice(prefix.length).trim(); }

  let wrapTag = null;
  const open = /^<([a-z]+)>/i.exec(lines[0]);
  if (open && new RegExp(`</${open[1]}>$`, "i").test(lines[lines.length - 1])){
    wrapTag = open[1];
    const openRe = new RegExp(`^<${wrapTag}>`, "i"), closeRe = new RegExp(`</${wrapTag}>$`, "i");
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(openRe, "").replace(closeRe, "").trim();
  }
  for (let i = 0; i < lines.length; i++){
    lines[i] = lines[i].replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
  }

  const dialogue = lines.length > 1 && lines.every(l => l.startsWith("-"));
  const units = dialogue ? lines.map(l => l.replace(/^-\s*/, "")) : [lines.join(" ")];
  return { prefix, wrapTag, dialogue, units };
}

function unitsToLines(plan, translated, rtlFix){
  let lines = plan.dialogue ? translated.map(t => `- ${t}`) : [translated[0]];
  if (plan.wrapTag) lines = lines.map(l => `<${plan.wrapTag}>${l}</${plan.wrapTag}>`);
  if (rtlFix) lines = lines.map(fixLine);
  if (plan.prefix) lines[0] = plan.prefix + lines[0];
  return lines;
}

// --- Google batching ---------------------------------------------------------
const MARKER_RE = /^¶¶(\d+)¶¶$/;
const MAX_BATCH_UNITS = 25;
const MAX_BATCH_CHARS = 1800;

function buildBatchText(texts){
  return texts.map((t, i) => `¶¶${i + 1}¶¶\n${t}`).join("\n");
}

function planBatches(units){ // units: [{id, text}]
  const batches = [];
  let cur = [], chars = 0;
  for (const u of units){
    const cost = u.text.length + 8;
    if (cur.length && (cur.length >= MAX_BATCH_UNITS || chars + cost > MAX_BATCH_CHARS)){
      batches.push(cur); cur = []; chars = 0;
    }
    cur.push(u); chars += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const normWs = s => String(s).replace(/\s+/g, " ").trim();

// Realigns a batch response to the texts that were sent. Google echoes each
// input segment in the `original` field (verified live, including when it
// splits one cue into several sentences), so a bucket is accepted only if its
// markers are in order AND its originals rebuild exactly the text sent for
// that cue. Anything else returns null and the caller retries those cues one
// by one — a translation is never attached to a cue it didn't come from.
function splitBatchResponse(segments, sentTexts){
  const buckets = [];
  let current = -1;
  for (const seg of segments){
    const translated = seg[0] == null ? "" : String(seg[0]);
    const original = seg[1] == null ? "" : String(seg[1]);
    const m = MARKER_RE.exec(original.trim());
    if (m){
      const n = Number(m[1]);
      if (n !== current + 2) return null; // duplicate, skipped or out-of-order marker
      current = n - 1;
      buckets[current] = { translated: [], original: [] };
      continue;
    }
    if (current < 0) return null; // text before the first marker
    buckets[current].translated.push(translated);
    buckets[current].original.push(original);
  }
  if (buckets.length !== sentTexts.length) return null;
  const out = [];
  for (let i = 0; i < sentTexts.length; i++){
    const b = buckets[i];
    if (!b) return null;
    if (normWs(b.original.join("")) !== normWs(sentTexts[i])) return null;
    const t = normWs(b.translated.join(""));
    if (!t) return null;
    out.push(t);
  }
  return out;
}

// Validates the response shape of the unofficial endpoint.
function parseGoogleResponse(data){
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const segs = [];
  for (const s of data[0]){
    if (!Array.isArray(s)) return null;
    segs.push([s[0], s[1]]);
  }
  return segs;
}

async function fetchGoogleTranslate(text, timeoutMs = 15000){
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=he&dt=t&q="
    + encodeURIComponent(text);
  let res;
  try{
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch(e){
    return { ok: false, error: e.name === "TimeoutError" ? "request timed out" : `network error (${e.message})` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let data;
  try{ data = await res.json(); }
  catch(e){ return { ok: false, error: "response was not valid JSON" }; }
  const segments = parseGoogleResponse(data);
  if (!segments) return { ok: false, error: "unexpected response format" };
  return { ok: true, segments };
}

// --- Orchestration (engine-agnostic so it can be unit-tested) ---------------
// deps.google(text) -> {ok, segments|error}; deps.local.get() -> translator
// with .translate(text). Returns per-unit results (null = not translated).
async function translateUnits(texts, deps){
  const {
    google, local,
    onProgress = () => {}, onEvent = () => {},
    concurrency = 3, maxConsecutiveFailures = 3,
    retryDelayMs = 1000, pacingMs = 150, localTimeoutMs = 30000,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = deps;
  const timeBox = (p, ms) => {
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), ms); });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
  };

  const n = texts.length;
  const results = new Array(n).fill(null);
  const engineOf = new Array(n).fill(null);
  let done = 0;
  const finish = (i, text, engine) => { results[i] = text; engineOf[i] = engine; done++; onProgress(done, n); };

  const pending = [];
  texts.forEach((t, i) => { if (!normWs(t)) finish(i, "", "none"); else pending.push({ id: i, text: t }); });

  let tripped = !google;
  let consecutive = 0;
  let nextStart = 0;
  const pace = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + pacingMs;
    if (wait) await sleep(wait);
  };
  const noteSuccess = () => { consecutive = 0; };
  const noteFailure = error => {
    consecutive++;
    if (!tripped && consecutive >= maxConsecutiveFailures){
      tripped = true;
      onEvent({ type: "tripped", error });
    }
  };

  // One request with one retry. null = skipped because the breaker tripped.
  async function googleCall(text){
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++){
      if (tripped) return null;
      await pace();
      let r;
      try{ r = await google(text); }
      catch(e){ r = { ok: false, error: e.message || String(e) }; }
      if (r && r.ok) return r;
      last = (r && r.error) || "unknown error";
      onEvent({ type: "request-failed", error: last, willRetry: attempt === 0 });
      if (attempt === 0) await sleep(retryDelayMs);
    }
    return { ok: false, error: last };
  }

  async function runBatch(batch){
    if (tripped) return;
    if (batch.length > 1){
      const r = await googleCall(buildBatchText(batch.map(u => u.text)));
      if (!r) return;
      if (r.ok){
        noteSuccess();
        const split = splitBatchResponse(r.segments, batch.map(u => u.text));
        if (split){ batch.forEach((u, k) => finish(u.id, split[k], "google")); return; }
        onEvent({ type: "realign-failed", size: batch.length });
      } else {
        noteFailure(r.error);
      }
    }
    for (const u of batch){
      const r = await googleCall(u.text);
      if (!r) return;
      if (!r.ok){ noteFailure(r.error); continue; }
      const t = normWs(r.segments.map(s => s[0] == null ? "" : s[0]).join(""));
      if (t){ noteSuccess(); finish(u.id, t, "google"); }
      else noteFailure("empty translation");
    }
  }

  if (google && pending.length){
    const batches = planBatches(pending);
    let next = 0;
    const worker = async () => { while (!tripped && next < batches.length) await runBatch(batches[next++]); };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  const leftover = pending.filter(u => results[u.id] === null);
  let localUnavailable = null;
  if (leftover.length && local){
    onEvent({ type: "local-start", count: leftover.length, tripped });
    let translator = null;
    try{ translator = await local.get(); }
    catch(e){ localUnavailable = e.message || String(e); onEvent({ type: "local-unavailable", error: localUnavailable }); }
    if (translator){
      for (const u of leftover){
        try{
          const t = normWs(await timeBox(translator.translate(u.text), localTimeoutMs));
          if (t) finish(u.id, t, "local");
          else onEvent({ type: "local-failed", error: "empty translation" });
        } catch(e){
          onEvent({ type: "local-failed", error: e.message || String(e) });
          if (e.message === "timed out"){ // a hung engine would cost the timeout on every remaining line
            localUnavailable = "the on-device translator stopped responding";
            onEvent({ type: "local-unavailable", error: localUnavailable });
            break;
          }
        }
      }
    }
  }

  return {
    results, engineOf, tripped, localUnavailable,
    failed: pending.filter(u => results[u.id] === null).map(u => u.id),
  };
}

// Translates the cues at `indices` in place. Malformed cues (no index or no
// timestamp) are never passed in — callers leave them untouched. A cue is
// only rewritten when every one of its units was translated; otherwise it
// keeps its original text and is reported as failed.
async function translateCues(cues, indices, rtlFix, deps){
  const plans = new Map();
  const texts = [];
  const owner = [];
  for (const ci of indices){
    const plan = cueToUnits(cues[ci].textLines);
    if (!plan) continue; // no text at all — nothing to translate
    plan.start = texts.length;
    for (const u of plan.units){ texts.push(u); owner.push(ci); }
    plans.set(ci, plan);
  }
  const run = await translateUnits(texts, deps);
  const failedCues = [];
  let googleUnits = 0, localUnits = 0;
  for (const [ci, plan] of plans){
    const slice = run.results.slice(plan.start, plan.start + plan.units.length);
    if (slice.some(t => t === null)){ failedCues.push(ci); continue; }
    cues[ci] = { ...cues[ci], textLines: unitsToLines(plan, slice, rtlFix) };
  }
  run.engineOf.forEach(e => { if (e === "google") googleUnits++; else if (e === "local") localUnits++; });
  return { translatedCues: plans.size - failedCues.length, failedCues, googleUnits, localUnits, run };
}

function heOutputName(sourceName){
  return TR_SRT.srtStem(sourceName).replace(/\.(en|eng|english)$/i, "") + ".he.srt";
}

// ---------------------------------------------------------------------------
// UI wiring (browser only)
// ---------------------------------------------------------------------------
if (typeof document !== "undefined") (function(){
  const $ = id => document.getElementById(id);
  const t = {
    fileInput: $("trFileInput"), fileBtn: $("trFileBtn"), fileName: $("trFileName"),
    fileDot: $("trFileDot"), fileStatus: $("trFileStatus"),
    runBtn: $("trRunBtn"), rtlCheck: $("trRtlCheck"), engineStatus: $("trEngineStatus"),
    warn: $("trWarnBanner"), err: $("trErrBanner"),
    log: $("trLog"), logEmpty: $("trLogEmpty"), clearLogBtn: $("trClearLogBtn"),
    downloadBtn: $("trDownloadBtn"), downloadLabel: $("trDownloadLabel"), retryBtn: $("trRetryBtn"),
  };
  if (!t.runBtn) return;

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const store = (k, v) => { try{ localStorage.setItem(k, v); } catch(e){} };

  try{ t.rtlCheck.checked = localStorage.getItem("rtlFixEnabled") !== "0"; } catch(e){}
  t.rtlCheck.addEventListener("change", () => store("rtlFixEnabled", t.rtlCheck.checked ? "1" : "0"));

  function log(html, cls){
    t.logEmpty.style.display = "none";
    t.log.style.display = "block";
    const row = document.createElement("div");
    row.className = "row" + (cls ? " " + cls : "");
    row.innerHTML = html;
    t.log.appendChild(row);
    t.log.scrollTop = t.log.scrollHeight;
    return row;
  }
  function progressRow(){
    const row = log(`<div class="pbar-wrap"><div class="pbar-track"><div class="pbar-fill"></div></div><span class="pbar-text">0%</span></div>`);
    const fill = row.querySelector(".pbar-fill"), text = row.querySelector(".pbar-text");
    return (done, total) => {
      const pct = total ? done / total : 1;
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      if (pct >= 1) fill.classList.add("done");
      text.textContent = `${done} / ${total} lines`;
    };
  }
  function clearLog(){
    t.log.innerHTML = ""; t.log.style.display = "none"; t.logEmpty.style.display = "block";
  }
  t.clearLogBtn.addEventListener("click", clearLog);

  function banner(el, html){
    if (html){ el.innerHTML = html; el.classList.add("show"); }
    else { el.innerHTML = ""; el.classList.remove("show"); }
  }

  // The on-device API can hang without ever resolving (seen in headless
  // Chromium), so every call to it is time-boxed and can never block the
  // online path.
  const withTimeout = (promise, ms, what) => {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't respond`)), ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  };
  const LANGS = { sourceLanguage: "en", targetLanguage: "he" };

  // Local engine: availability is only ever reported from a real runtime check.
  const local = {
    status: "unchecked", instance: null,
    async check(){
      if (typeof Translator === "undefined" || typeof Translator.availability !== "function"){ this.status = "unsupported"; return this.status; }
      try{ this.status = await withTimeout(Translator.availability(LANGS), 3000, "on-device availability check"); }
      catch(e){ this.status = "no-response"; }
      return this.status;
    },
    // Creates the translator now, while the click's user activation is still
    // fresh. A "downloadable" model is only fetched when the user explicitly
    // retries — never speculatively on a first run.
    async warm(allowDownload){
      if (this.instance) return;
      const download = allowDownload && (this.status === "downloadable" || this.status === "downloading");
      if (this.status !== "available" && !download) return;
      try{
        this.instance = await withTimeout(Translator.create(LANGS), download ? 180000 : 8000, "on-device translator");
        this.status = "available";
      } catch(e){}
    },
    async get(){
      if (this.instance) return this.instance;
      if (!["available", "downloadable", "downloading"].includes(this.status)){
        throw new Error(this.status === "no-response"
          ? "the on-device translator didn't respond"
          : "on-device English→Hebrew translation isn't available in this browser");
      }
      this.instance = await withTimeout(Translator.create(LANGS), 15000, "on-device translator");
      return this.instance;
    },
  };
  const localLabel = () => ({
    unchecked: "on-device fallback not checked yet",
    unsupported: "no on-device fallback in this browser",
    unavailable: "on-device English→Hebrew not available",
    downloadable: "on-device fallback needs a one-time download",
    downloading: "on-device fallback is downloading",
    available: "on-device fallback ready",
    "no-response": "on-device fallback didn't respond",
  }[local.status] || `on-device fallback: ${local.status}`);
  function showEngine(active){
    const main = active === "local"
      ? `<b class="eng-local">Chrome on-device (local)</b> — text stays on this computer`
      : `<b class="eng-online">Google Translate (online)</b> — text is sent to Google`;
    t.engineStatus.innerHTML = `Engine: ${main} · ${esc(localLabel())}`;
  }
  showEngine("google");

  let source = null;  // {name, cues, malformed}
  let result = null;  // {cues, failedCues}

  function resetOutput(){
    result = null;
    t.downloadBtn.hidden = true;
    t.retryBtn.hidden = true;
    banner(t.warn, ""); banner(t.err, "");
  }

  t.fileBtn.addEventListener("click", () => t.fileInput.click());
  t.fileInput.addEventListener("change", async () => {
    const file = t.fileInput.files[0];
    t.fileInput.value = "";
    if (!file) return;
    resetOutput();
    source = null;
    t.runBtn.disabled = true;
    t.fileName.textContent = file.name;
    t.fileName.classList.remove("empty");
    if (file.size > 10 * 1024 * 1024){
      t.fileDot.className = "dot warn";
      t.fileStatus.textContent = "File is too large to be a subtitle file";
      return;
    }
    const { text, encoding } = TR_SRT.decodeSubtitleBytes(await file.arrayBuffer(), "windows-1252");
    const parsed = TR_SRT.parseSrt(text);
    const usable = parsed.cues.filter(c => c.index != null && c.timestamp != null).length;
    if (!usable){
      t.fileDot.className = "dot warn";
      t.fileStatus.textContent = "No subtitle cues found — is this an .srt file?";
      return;
    }
    source = { name: file.name, cues: parsed.cues, malformed: parsed.malformed };
    t.fileDot.className = "dot ok";
    t.fileStatus.textContent = `${usable} cues` + (parsed.malformed ? ` · ${parsed.malformed} malformed block(s) will be left unchanged` : "")
      + (encoding !== "UTF-8" ? ` · read as ${encoding}` : "");
    t.runBtn.disabled = false;
  });

  async function run(indices, isRetry){
    t.runBtn.disabled = true;
    t.retryBtn.hidden = true;
    banner(t.warn, ""); banner(t.err, "");
    const working = isRetry ? result.cues.map(c => ({ ...c })) : source.cues.map(c => ({ ...c }));

    // Check the fallback while we still hold this click's user activation:
    // creating the on-device translator may need it.
    await local.check();
    if (isRetry && (local.status === "downloadable" || local.status === "downloading")){
      log("Downloading the on-device translation model (one time)…", "dim");
    }
    await local.warm(isRetry);
    showEngine("google");

    log(`📄 ${esc(source.name)} — ${isRetry ? `retrying ${indices.length} cue(s)` : `${indices.length} cues`}`, "cyan");
    if (!isRetry && source.malformed) log(`⚠ ${source.malformed} malformed block(s) without a valid index or timestamp — left unchanged in the output.`, "warn");
    const setProgress = progressRow();

    let outcome;
    try{
      outcome = await translateCues(working, indices, t.rtlCheck.checked, {
        google: fetchGoogleTranslate,
        local,
        onProgress: setProgress,
        onEvent(ev){
          if (ev.type === "request-failed") log(`· Google request failed (${esc(ev.error)})${ev.willRetry ? " — retrying" : ""}`, "dim");
          else if (ev.type === "realign-failed") log(`· A batch of ${ev.size} came back in an unexpected shape — translating those cues one by one`, "dim");
          else if (ev.type === "tripped") log(`⚠ Online translation stopped responding after repeated failures (${esc(ev.error)}).`, "warn");
          else if (ev.type === "local-start"){
            showEngine("local");
            log(`→ Switching ${ev.count} remaining line(s) to the on-device Chrome translator — quality may differ for these.`, "warn");
          }
          else if (ev.type === "local-unavailable") log(`✗ On-device translator unavailable: ${esc(ev.error)}`, "err");
          else if (ev.type === "local-failed") log(`· On-device translation failed for a line (${esc(ev.error)})`, "dim");
        },
      });
    } catch(e){
      log(`✗ Unexpected error: ${esc(e.message || e)}`, "err");
      banner(t.err, "Translation failed unexpectedly. Nothing was downloaded — try again.");
      t.runBtn.disabled = false;
      return;
    }

    const failed = outcome.failedCues;
    const attempted = outcome.translatedCues + failed.length;
    if (outcome.googleUnits) log(`✓ ${outcome.googleUnits} line(s) translated online (Google)`, "ok");
    if (outcome.localUnits) log(`✓ ${outcome.localUnits} line(s) translated on-device`, "ok");
    if (t.rtlCheck.checked && outcome.translatedCues) log(`✓ RTL punctuation fix applied`, "ok");

    // Integrity gate before anything can be downloaded.
    const out = TR_SRT.stringifySrt(working);
    if (working.length !== source.cues.length || !out.trim()){
      banner(t.err, "The output failed an integrity check (cue count changed). Nothing was downloaded.");
      log("✗ Integrity check failed — output discarded", "err");
      t.runBtn.disabled = false;
      return;
    }

    result = { cues: working, failedCues: failed, text: out };
    const label = c => working[c].index || `#${c + 1}`;

    if (attempted > 0 && outcome.translatedCues === 0 && !isRetry){
      banner(t.err, `None of the ${attempted} cues could be translated. Nothing was downloaded — check your connection and try again.`);
      log("✗ Translation failed for every cue", "err");
      result = null;
      t.runBtn.disabled = false;
      return;
    }

    t.downloadLabel.textContent = `Download ${heOutputName(source.name)}`;
    t.downloadBtn.hidden = false;
    if (failed.length){
      const list = failed.slice(0, 15).map(label).join(", ") + (failed.length > 15 ? ", …" : "");
      banner(t.warn, `⚠ ${failed.length} of ${attempted} cues could not be translated and are still in English (cues: ${esc(list)}). `
        + `The file below is incomplete — retry those cues or download it anyway.`);
      log(`⚠ Done with ${failed.length} untranslated cue(s) — download is incomplete`, "warn");
      t.retryBtn.hidden = false;
    } else {
      log(`Done: ${outcome.translatedCues} cues translated.`, "ok");
      TR_SRT.downloadTextFile(heOutputName(source.name), out);
    }
    t.runBtn.disabled = false;
  }

  t.runBtn.addEventListener("click", () => {
    if (!source) return;
    resetOutput();
    const indices = source.cues.map((c, i) => i).filter(i => source.cues[i].index != null && source.cues[i].timestamp != null);
    run(indices, false);
  });
  t.retryBtn.addEventListener("click", () => {
    if (!result || !result.failedCues.length) return;
    run(result.failedCues, true);
  });
  t.downloadBtn.addEventListener("click", () => {
    if (result) TR_SRT.downloadTextFile(heOutputName(source.name), result.text);
  });
})();

if (typeof module !== "undefined" && module.exports){
  module.exports = {
    fixText, fixLine, cueToUnits, unitsToLines,
    buildBatchText, planBatches, splitBatchResponse, parseGoogleResponse,
    translateUnits, translateCues, heOutputName,
  };
}
