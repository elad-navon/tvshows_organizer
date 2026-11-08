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

// ---------------------------------------------------------------------------
// Gemini engine: context-aware translation with a language model.
// Google Translate sees each line alone, so it can't tell who speaks to whom
// (Hebrew is gendered), splits sentences badly and translates idioms
// literally. Here the model first reads the whole episode and writes a
// reference sheet (characters + gender, glossary, tone), then translates in
// batches with the sheet, a running "story so far", the previous translated
// lines and a peek at the next lines.
// ---------------------------------------------------------------------------
// Measured 2026-11-07 on the free tier, 60 cues: gemini-3.5-flash with low
// thinking ~8s; gemini-3.8-flash / gemini-flash-latest 130-190s (overloaded);
// the Lite models are fast but translate noticeably worse. Google retires
// models (2.5 is already closed to new keys), so a retired model falls back.
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
// Gemma via the same key and API (2026-11-08 free tier: 14,400 requests/day,
// 30/minute, but only 16K tokens/minute). A 100-line request is ~8K tokens
// in+out and took ~2 min; the whole-episode sheet read used 15.3K. Hence
// smaller batches, a full minute between requests and a compact transcript.
const GEMMA = { model: "gemma-4-31b-it", batchSize: 100, pacingMs: 65000, timeoutMs: 300000 };
const GEMINI_FALLBACK_MODEL = "gemini-flash-latest";
// Free tier (2026-11-07): Flash = 20 requests/day, 5/minute. 250 cues per
// request = 3-4 requests per episode; Lite at 250 translated as well as at 80.
const GEMINI_BATCH = 250;
const GEMINI_PREV = 8;
const GEMINI_NEXT = 5;
const GEMINI_NEAR = 3;   // context lines on each side of a line asked again
const GEMINI_CARRY = 10; // this many left-out lines wait for the next batch

const GEMINI_SHEET_SCHEMA = {
  type: "OBJECT",
  properties: {
    synopsis: { type: "STRING" },
    characters: { type: "ARRAY", items: { type: "OBJECT", properties: {
      name: { type: "STRING" }, hebrew: { type: "STRING" },
      gender: { type: "STRING", enum: ["male", "female", "unknown"] }, notes: { type: "STRING" },
    }, required: ["name", "hebrew", "gender"] } },
    glossary: { type: "ARRAY", items: { type: "OBJECT", properties: { en: { type: "STRING" }, he: { type: "STRING" } }, required: ["en", "he"] } },
    tone: { type: "STRING" },
  },
  required: ["synopsis", "characters", "glossary", "tone"],
};

const GEMINI_BATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    // "en" comes before "text": copying the English line first anchors each
    // Hebrew text to its own id (Doc S03E06: without it, two stretches of a
    // 250-cue batch drifted one cue early where sentences spanned cues).
    translations: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, en: { type: "STRING" }, text: { type: "STRING" } }, required: ["id", "en", "text"], propertyOrdering: ["id", "en", "text"] } },
    story_so_far: { type: "STRING" },
  },
  required: ["translations", "story_so_far"],
  propertyOrdering: ["translations", "story_so_far"],
};

// Letters of scripts that never belong in a Hebrew subtitle (Gemma and Lite
// sometimes slip one in: "התינוק הא可רש", "השم", "אנדรียა"): Greek, Cyrillic,
// Arabic, Armenian, Georgian, Indic, Thai, CJK, Korean. Letters the English line itself has are allowed.
const FOREIGN_SCRIPT = /[\u0370-\u03FF\u0400-\u058F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u0DFF\u0E00-\u0E7F\u10A0-\u10FF\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFB50-\uFDFF\uFE70-\uFEFC]/gu;
function hasForeignScript(text, source){
  const found = String(text || "").match(FOREIGN_SCRIPT);
  if (!found) return false;
  const own = new Set(String(source || "").match(FOREIGN_SCRIPT) || []);
  return found.some(ch => !own.has(ch));
}
function stripForeignScript(text){
  return String(text || "").replace(FOREIGN_SCRIPT, "").replace(/[ \t]{2,}/g, " ").trim();
}

// Words of an English line for comparing the model's echo with the source.
function echoWords(text){
  return String(text || "").replace(/\\n/g, " ").replace(/<[^>]+>/g, " ").toLowerCase()
    .replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

// True when the model's copy of the English ("en") is the line of that id:
// the first words agree. An answer with no letters in the source (♪, numbers
// only) or no echo at all is not judged.
function echoMatches(source, en){
  const a = echoWords(source), b = echoWords(en);
  if (!a.length || en == null) return true;
  const n = Math.min(3, a.length);
  if (b.length < n) return false;
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return false;
  return true;
}

const GEMINI_SHEET_SYSTEM = `You prepare a translator's reference sheet for a TV/movie episode whose English subtitles will be translated into Hebrew.
Read the whole subtitle transcript and return:
- synopsis: 4-8 sentences (in English) of what happens, who is involved, relationships.
- characters: every named or recurring character, with the Hebrew spelling of the name (as Israeli subtitlers would write it), gender (inferred from pronouns, titles and context; "unknown" only if truly unclear), and short notes (role, relationships, how they address others).
- glossary: recurring places, organizations, nicknames, invented terms and catchphrases, with the Hebrew rendering to use consistently. Never translate personal names literally.
- tone: genre and register (e.g. "crime drama, lots of slang and profanity").`;

const GEMINI_BATCH_SYSTEM = `You are a professional Israeli subtitle translator. Translate English subtitles into natural, fluent spoken Hebrew, as a skilled human subtitler would for Israeli TV.
Rules:
- Translate meaning, not words. Use the scene: who speaks, to whom, what is happening. Idioms, jokes and slang get natural Hebrew equivalents.
- Hebrew is gendered. For every line work out the speaker and the addressee (use the characters list, the story so far and the surrounding lines) and use the correct gender for "you", verbs and adjectives, in first and second person. A group addressee is plural.
- A sentence may be split across several cues: each cue keeps its own part, but the whole sentence must read correctly in Hebrew. Each id's Hebrew covers only that id's English: never move words into a neighboring id, and never repeat them there. When Hebrew word order differs, rephrase so every cue still says its own part at its own time.
- For every id, first copy its English line into "en" exactly as given in the BATCH (without the time and budget), then write its Hebrew in "text".
- Keep the register: profanity stays profanity, formal stays formal.
- Use the glossary and the Hebrew character names consistently.
- Keep subtitles short and readable: at most 2 lines per cue, about 40 characters per line; separate lines with "\\n".
- Viewers must be able to read every cue in the time it is on screen. Each BATCH line shows its display time and a character budget, like "(1.5s, max 24 chars)". Stay within the budget (both lines together, spaces and punctuation included). When the full wording doesn't fit, condense as a professional subtitler would: drop fillers (well, uh, you know, okay, look), repetitions and names in direct address, and rephrase more briefly. Keep everything that matters to the plot.

- A cue whose lines start with "- " is a dialogue between speakers: keep one "- " line per speaker, in the same order.
- Translate sound descriptions like [door slams], keeping the brackets. Keep symbols like ♪.
- No niqqud, no HTML tags, no explanations.
- Return exactly one translation for every id in the BATCH section, with the same ids. Never translate the context sections.
- BATCH ids are not always consecutive: a line left out earlier may be asked again. Use NEARBY LINES (the lines around it, with their Hebrew when already translated) to understand it and to keep its gender and wording consistent with them.
- Also return story_so_far: an updated short English summary (max 6 sentences) of the story up to the end of this batch.`;

// --- Reading speed -----------------------------------------------------------
// English subtitles are often near-verbatim, so in fast scenes a cue is on
// screen ~1.5s with 40+ characters (Marshals S02E05: 105 of 680 cues above 17
// chars/s, and almost none had free time after them). So the model gets a
// character budget per cue and condenses, and after translation a cue that is
// still too fast is shown longer when the gap before the next cue allows it.
const READ_CPS = 16;          // target reading speed, characters per second
const READ_MIN_GAP_MS = 100;  // keep cues at least this far apart
const READ_MAX_EXTRA_MS = 1500;

const visibleLength = lines => lines.map(l => l.replace(/<[^>]+>|\{\\[^}]*\}/g, "").trim()).join(" ").length;

// Start time of the next timed cue after index i (null at the end).
function nextStartMs(cues, i){
  for (let j = i + 1; j < cues.length; j++){
    const t = cues[j].timestamp && TR_SRT.parseTimestampLine(cues[j].timestamp);
    if (t) return t.startMs;
  }
  return null;
}

// Display time (seconds, including what extendForReading may add) and the
// character budget for cue i. null when the timestamp can't be read.
function readingBudget(cues, i){
  const t = cues[i].timestamp && TR_SRT.parseTimestampLine(cues[i].timestamp);
  if (!t || t.endMs <= t.startMs) return null;
  const next = nextStartMs(cues, i);
  const room = next == null ? READ_MAX_EXTRA_MS : Math.max(0, Math.min(READ_MAX_EXTRA_MS, next - READ_MIN_GAP_MS - t.endMs));
  const ms = t.endMs - t.startMs + room;
  return { seconds: ms / 1000, maxChars: Math.min(84, Math.max(12, Math.floor(ms / 1000 * READ_CPS))) };
}

// Lengthens cues (in place) that are too fast to read, into the free time
// before the next cue. Never moves a start time or overlaps the next cue.
// Returns how many cues were lengthened.
function extendForReading(cues, indices){
  let n = 0;
  for (const i of indices){
    const c = cues[i];
    const t = c && c.timestamp && TR_SRT.parseTimestampLine(c.timestamp);
    if (!t || t.endMs <= t.startMs) continue;
    const need = Math.ceil(visibleLength(c.textLines) / READ_CPS * 1000);
    if (t.endMs - t.startMs >= need) continue;
    const next = nextStartMs(cues, i);
    let end = Math.min(t.startMs + need, t.endMs + READ_MAX_EXTRA_MS);
    if (next != null) end = Math.min(end, next - READ_MIN_GAP_MS);
    if (end <= t.endMs) continue;
    cues[i] = { ...c, timestamp: TR_SRT.formatTimestampLine(t.startMs, end, t.rest) };
    n++;
  }
  return n;
}

const GEMINI_CONDENSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    translations: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, text: { type: "STRING" } }, required: ["id", "text"] } },
  },
  required: ["translations"],
};

const GEMINI_CONDENSE_SYSTEM = `You are a professional Israeli subtitle editor. Each cue below has a Hebrew subtitle that is too long to read in the time it is on screen. Rewrite each one to fit its character budget (spaces and punctuation included).
- Condense as a professional subtitler would: drop fillers, repetitions and names in direct address, use shorter words and phrasing. Keep everything that matters to the plot.
- Keep the same meaning, speaker, gender forms, register and names as the current Hebrew.
- Keep "\\n" line breaks for 2-line cues, and one "- " line per speaker in dialogue cues.
- No niqqud, no HTML tags, no explanations. Return one text for every id.`;

// The text sent for one cue (markup already lifted out by cueToUnits).
function geminiSourceText(plan){
  return plan.dialogue ? plan.units.map(u => `- ${u}`).join("\n") : plan.units[0];
}

// A line longer than `max` becomes two, split at the space nearest the middle.
function splitLongLine(line, max = 42){
  if (line.length <= max) return [line];
  const mid = line.length / 2;
  let best = -1;
  for (let i = line.indexOf(" "); i !== -1; i = line.indexOf(" ", i + 1)){
    if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  if (best === -1) return [line];
  return [line.slice(0, best).trim(), line.slice(best + 1).trim()];
}

// Turns the model's text for one cue back into subtitle lines, restoring the
// lifted markup. null = unusable (empty).
function geminiLines(plan, text, rtlFix){
  let lines = String(text == null ? "" : text).replace(/\\n/g, "\n").split("\n")
    .map(l => l.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim()).filter(Boolean);
  if (!lines.length) return null;
  if (plan.dialogue) lines = lines.map(l => l.startsWith("-") ? `- ${l.replace(/^-\s*/, "")}` : l);
  else {
    lines = lines.map(l => l.replace(/^-\s*/, ""));
    // The model usually ignores the 2-line hint; split one long line itself.
    if (lines.length === 1) lines = splitLongLine(lines[0]);
  }
  if (plan.wrapTag) lines = lines.map(l => `<${plan.wrapTag}>${l}</${plan.wrapTag}>`);
  if (rtlFix) lines = lines.map(fixLine);
  if (plan.prefix) lines[0] = plan.prefix + lines[0];
  return lines;
}

// One generateContent call. Returns {ok, data} or {ok:false, error, retryMs,
// daily, fatal}: `daily` = free daily quota used up, `fatal` = retrying won't help.
async function fetchGemini({ key, model, system, user, schema, timeoutMs = 180000, thinkingLevel = "low" }){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || GEMINI_DEFAULT_MODEL)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: schema },
  };
  if (thinkingLevel) body.generationConfig.thinkingConfig = { thinkingLevel };
  let res, json;
  try{
    res = await fetch(url, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    json = await res.json().catch(() => ({}));
  } catch(e){
    return { ok: false, error: e.name === "TimeoutError" ? "request timed out" : `network error (${e.message})` };
  }
  if (!res.ok){
    const error = `HTTP ${res.status}${json.error && json.error.message ? ` — ${json.error.message.split("\n")[0]}` : ""}`;
    if (res.status === 429 || res.status >= 500){
      const raw = JSON.stringify(json);
      const daily = res.status === 429 && /per ?day/i.test(raw);
      const info = (json.error && json.error.details || []).find(d => d.retryDelay);
      const retryMs = info ? parseFloat(info.retryDelay) * 1000 + 1000 : null;
      return { ok: false, error, retryMs, daily };
    }
    // A model that doesn't take this thinking level: ask again without it.
    if (res.status === 400 && thinkingLevel && /thinking/i.test(error)){
      return fetchGemini({ key, model, system, user, schema, timeoutMs, thinkingLevel: null });
    }
    // A retired model: same request on the fallback model.
    const retired = res.status === 404 || /no longer available/i.test(error);
    if (retired && model !== GEMINI_FALLBACK_MODEL){
      return fetchGemini({ key, model: GEMINI_FALLBACK_MODEL, system, user, schema, timeoutMs, thinkingLevel });
    }
    return { ok: false, error, fatal: true }; // bad key, bad request
  }
  const cand = json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const txt = parts.filter(p => !p.thought).map(p => p.text || "").join("");
  if (!txt) return { ok: false, error: `empty response${cand && cand.finishReason ? ` (${cand.finishReason})` : ""}` };
  try{ return { ok: true, data: JSON.parse(txt) }; }
  catch(e){ return { ok: false, error: "response was not valid JSON" }; }
}

// Translates source cues at `indices` into `working` (same length, same
// order). deps.gemini(system, user, schema) -> fetchGemini-style result.
// deps.sheet: a reference sheet from an earlier run of the same file (reused
// on retry). A cue is rewritten only when the model returned text for it.
async function translateCuesGemini(sourceCues, working, indices, rtlFix, deps){
  const {
    gemini, onProgress = () => {}, onEvent = () => {},
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    pacingMs = 12000, maxAttempts = 6, batchSize = GEMINI_BATCH, compactSheet = false,
  } = deps;
  let sheet = deps.sheet || null;
  let story = deps.story || "";

  // Every usable cue gets a plan (for context); id = position in the file + 1.
  const plans = new Map();
  sourceCues.forEach((c, i) => {
    if (c.index == null || c.timestamp == null) return;
    const plan = cueToUnits(c.textLines);
    if (plan) plans.set(i, plan);
  });
  const usable = [...plans.keys()];
  const line = i => `[${i + 1}] ${geminiSourceText(plans.get(i)).replace(/\n/g, " \\n ")}`;
  const batchLine = i => {
    const b = readingBudget(sourceCues, i);
    return b ? `[${i + 1}] (${b.seconds.toFixed(1)}s, max ${b.maxChars} chars) ${line(i).slice(line(i).indexOf("]") + 2)}` : line(i);
  };

  const todo = indices.filter(i => plans.has(i)).sort((a, b) => a - b);
  const done = new Set();
  const raw = new Map(); // model text per cue, before markup/RTL fix
  let progress = 0;
  onProgress(0, todo.length);

  let lastCall = 0, stopped = null;
  async function call(system, user, schema){
    for (let attempt = 1; attempt <= maxAttempts; attempt++){
      const wait = lastCall + pacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      let r;
      try{ r = await gemini(system, user, schema); }
      catch(e){ r = { ok: false, error: e.message || String(e) }; }
      if (r && r.ok) return r.data;
      if (r.daily || r.fatal){ stopped = r.daily ? "the free daily Gemini quota is used up — try again tomorrow" : r.error; return null; }
      const ms = r.retryMs || 5000 * attempt;
      onEvent({ type: "request-failed", error: r.error, willRetry: attempt < maxAttempts, waitMs: ms });
      if (attempt < maxAttempts) await sleep(ms);
    }
    return null;
  }

  if (!sheet && todo.length){
    onEvent({ type: "sheet-start" });
    // compactSheet: plain lines without ids, for a model with a small per-minute token budget
    const transcript = compactSheet ? usable.map(i => geminiSourceText(plans.get(i)).replace(/\n/g, " ")) : usable.map(line);
    const data = await call(GEMINI_SHEET_SYSTEM, `TRANSCRIPT:\n${transcript.join("\n")}`, GEMINI_SHEET_SCHEMA);
    if (data && Array.isArray(data.characters)){ sheet = data; onEvent({ type: "sheet-done", sheet }); }
    else if (!stopped) onEvent({ type: "sheet-failed" });
  }

  // A line shown for context: its English, and its Hebrew once translated.
  // (also lines translated by an earlier run, when this is a retry)
  const translated = i => done.has(i) || working[i].textLines.join("\n") !== sourceCues[i].textLines.join("\n");
  const contextLine = i => translated(i) ? `${line(i)}\n   => ${working[i].textLines.join(" \\n ")}` : line(i);
  // Lines next to each BATCH line that the request doesn't already show. A
  // whole batch has none (prev/next cover its edges); a line asked again on
  // its own, or carried into the next batch, gets the lines around it.
  const nearbyOf = (ids, shown) => {
    const pos = new Map(usable.map((i, p) => [i, p]));
    const out = new Set();
    for (const i of ids){
      const p = pos.get(i);
      for (let q = Math.max(0, p - GEMINI_NEAR); q <= Math.min(usable.length - 1, p + GEMINI_NEAR); q++){
        const j = usable[q];
        if (!shown.has(j)) out.add(j);
      }
    }
    return [...out].sort((a, b) => a - b);
  };

  let carry = []; // a few lines the previous batch left out, sent with this one
  for (let b = 0; b < todo.length && !stopped; b += batchSize){
    const batch = todo.slice(b, b + batchSize);
    const first = usable.indexOf(batch[0]), last = usable.indexOf(batch[batch.length - 1]);
    const prev = usable.slice(Math.max(0, first - GEMINI_PREV), first);
    const next = usable.slice(last + 1, last + 1 + GEMINI_NEXT);
    const isLast = b + batchSize >= todo.length;
    onEvent({ type: "batch-start", n: b / batchSize + 1, of: Math.ceil(todo.length / batchSize) });

    let missing = [...carry, ...batch].sort((x, y) => x - y);
    carry = [];
    for (let tries = 0; tries < 3 && missing.length && !stopped; tries++){
      const asked = new Set(missing);
      const before = prev.filter(i => !asked.has(i)); // a carried line sits in prev
      const nearby = nearbyOf(missing, new Set([...missing, ...before, ...next]));
      const user = [
        sheet ? `REFERENCE SHEET:\n${JSON.stringify(sheet)}` : "",
        `STORY SO FAR:\n${story || "(start of episode)"}`,
        nearby.length ? `NEARBY LINES (context only, do not translate):\n${nearby.map(contextLine).join("\n")}` : "",
        before.length ? `PREVIOUS LINES (context only):\n${before.map(contextLine).join("\n")}` : "",
        `BATCH (translate every id):\n${missing.map(batchLine).join("\n")}`,
        next.length ? `NEXT LINES (context only, do not translate):\n${next.map(line).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const data = await call(GEMINI_BATCH_SYSTEM, user, GEMINI_BATCH_SCHEMA);
      if (!data) break;
      const want = new Set(missing);
      let drifted = 0, foreign = 0;
      for (const t of Array.isArray(data.translations) ? data.translations : []){
        const i = Number(t && t.id) - 1;
        if (!want.has(i) || done.has(i)) continue;
        if (!echoMatches(geminiSourceText(plans.get(i)), t.en)){ drifted++; continue; }
        // A stray letter from another script ("הא可רש") is asked again; on
        // the last try the letters are dropped rather than lose the line.
        const stray = hasForeignScript(t.text, geminiSourceText(plans.get(i)));
        if (stray && tries < 2){ foreign++; continue; }
        const lines = geminiLines(plans.get(i), stray ? stripForeignScript(t.text) : t.text, rtlFix);
        if (!lines) continue;
        working[i] = { ...working[i], textLines: lines };
        raw.set(i, String(t.text));
        done.add(i);
        onProgress(++progress, todo.length);
      }
      if (typeof data.story_so_far === "string" && data.story_so_far.trim()) story = data.story_so_far.trim();
      missing = missing.filter(i => !done.has(i));
      if (drifted) onEvent({ type: "drifted", count: drifted });
      if (foreign) onEvent({ type: "foreign", count: foreign });
      // A few left-out lines ride along with the next batch instead of
      // costing a request of their own (the free tier allows 20 a day).
      if (missing.length && missing.length <= GEMINI_CARRY && !isLast){
        carry = missing;
        onEvent({ type: "carried", count: missing.length });
        break;
      }
      if (missing.length && tries < 2) onEvent({ type: "missing", count: missing.length });
    }
  }

  // One extra request per run: the model mostly ignores the budget while
  // translating 250 cues, so cues still well over budget are sent back to be
  // condensed. A shorter answer replaces the cue; a failure keeps it as is.
  let condensed = 0;
  const over = stopped ? [] : [...raw.keys()].filter(i => {
    const b = readingBudget(sourceCues, i);
    return b && visibleLength(working[i].textLines) > b.maxChars * 1.1;
  }).sort((a, b) => a - b);
  if (over.length){
    onEvent({ type: "condense-start", count: over.length });
    const user = [
      sheet ? `REFERENCE SHEET:\n${JSON.stringify({ characters: sheet.characters, glossary: sheet.glossary })}` : "",
      `CUES TO SHORTEN:\n${over.map(i => {
        const b = readingBudget(sourceCues, i);
        return `[${i + 1}] (max ${b.maxChars} chars) EN: ${line(i).slice(line(i).indexOf("]") + 2)}\n   HE now (${visibleLength(working[i].textLines)} chars): ${raw.get(i).replace(/\n/g, " \\n ")}`;
      }).join("\n")}`,
    ].filter(Boolean).join("\n\n");
    const data = await call(GEMINI_CONDENSE_SYSTEM, user, GEMINI_CONDENSE_SCHEMA);
    const want = new Set(over);
    for (const t of data && Array.isArray(data.translations) ? data.translations : []){
      const i = Number(t && t.id) - 1;
      if (!want.has(i)) continue;
      want.delete(i);
      if (hasForeignScript(t.text, geminiSourceText(plans.get(i)))) continue;
      const lines = geminiLines(plans.get(i), t.text, rtlFix);
      if (!lines || visibleLength(lines) >= visibleLength(working[i].textLines)) continue;
      working[i] = { ...working[i], textLines: lines };
      condensed++;
    }
    onEvent({ type: "condense-done", count: condensed });
  }
  if (stopped) onEvent({ type: "stopped", error: stopped });

  const failedCues = todo.filter(i => !done.has(i));
  return { translatedCues: done.size, failedCues, sheet, story, stopped, condensed };
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
    engGemini: $("trEngineGemini"), engGemma: $("trEngineGemma"), engGoogle: $("trEngineGoogle"),
    keyRow: $("trKeyRow"), keyInput: $("trKeyInput"), keyHint: $("trKeyHint"), googleHint: $("trGoogleHint"),
    gemmaHint: $("trGemmaHint"),
  };
  if (!t.runBtn) return;

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const store = (k, v) => { try{ localStorage.setItem(k, v); } catch(e){} };
  const read = k => { try{ return localStorage.getItem(k); } catch(e){ return null; } };

  // Engine choice + Gemini key, remembered in this browser only.
  t.keyInput.value = read("geminiApiKey") || "";
  if (read("trEngine") === "google") t.engGoogle.checked = true;
  if (read("trEngine") === "gemma") t.engGemma.checked = true;
  const geminiModel = () => read("geminiModel") || GEMINI_DEFAULT_MODEL;
  const engine = () => t.engGoogle.checked ? "google" : t.engGemma.checked ? "gemma" : "gemini";
  function syncEngineUi(){
    const e = engine();
    t.keyRow.hidden = e === "google"; t.keyHint.hidden = e !== "gemini";
    t.gemmaHint.hidden = e !== "gemma"; t.googleHint.hidden = e !== "google";
    showEngine(e);
  }
  [t.engGemini, t.engGemma, t.engGoogle].forEach(r => r.addEventListener("change", () => { store("trEngine", engine()); syncEngineUi(); }));
  t.keyInput.addEventListener("input", () => store("geminiApiKey", t.keyInput.value.trim()));

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
    if (active === "gemini" || active === "gemma"){
      const name = active === "gemma" ? `Gemma (${GEMMA.model}, online)` : `Gemini (${esc(geminiModel())}, online)`;
      t.engineStatus.innerHTML = `Engine: <b class="eng-online">${name}</b> — text is sent to Google's Gemini API`;
      return;
    }
    const main = active === "local"
      ? `<b class="eng-local">Chrome on-device (local)</b> — text stays on this computer`
      : `<b class="eng-online">Google Translate (online)</b> — text is sent to Google`;
    t.engineStatus.innerHTML = `Engine: ${main} · ${esc(localLabel())}`;
  }
  syncEngineUi();

  let source = null;  // {name, cues, malformed}
  let result = null;  // {cues, failedCues, sheet, story}

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
    const kind = isRetry ? result.engine : engine();
    if (kind === "gemini" || kind === "gemma") return runGemini(indices, isRetry, working, kind);

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

    result = { cues: working, failedCues: failed, text: out, engine: "google" };
    finishRun(working, failed, attempted, outcome.translatedCues, isRetry);
  }

  async function runGemini(indices, isRetry, working, kind){
    const gemma = kind === "gemma";
    const label = gemma ? "Gemma" : "Gemini";
    const key = t.keyInput.value.trim();
    if (!key){
      banner(t.err, `Paste your Gemini API key first (free at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>), or choose Google Translate.`);
      t.runBtn.disabled = false;
      return;
    }
    const model = gemma ? GEMMA.model : geminiModel();
    showEngine(kind);
    log(`📄 ${esc(source.name)} — ${isRetry ? `retrying ${indices.length} cue(s)` : `${indices.length} cues`} · ${label}`, "cyan");
    if (gemma) log(`Gemma translates ${GEMMA.batchSize} lines per request with a one-minute pause between requests — keep this tab open (about 2–3 minutes per 100 lines).`, "dim");
    if (!isRetry && source.malformed) log(`⚠ ${source.malformed} malformed block(s) without a valid index or timestamp — left unchanged in the output.`, "warn");
    const setProgress = progressRow();

    let outcome;
    try{
      outcome = await translateCuesGemini(source.cues, working, indices, t.rtlCheck.checked, {
        gemini: gemma
          ? (system, user, schema) => fetchGemini({ key, model, system, user, schema, timeoutMs: GEMMA.timeoutMs, thinkingLevel: null })
          : (system, user, schema) => fetchGemini({ key, model, system, user, schema }),
        ...(gemma ? { batchSize: GEMMA.batchSize, pacingMs: GEMMA.pacingMs, compactSheet: true } : {}),
        sheet: isRetry ? result.sheet : null,
        story: isRetry ? result.story : "",
        onProgress: setProgress,
        onEvent(ev){
          if (ev.type === "sheet-start") log("Reading the whole episode for context…", "dim");
          else if (ev.type === "sheet-done"){
            const ch = ev.sheet.characters.slice(0, 12).map(c => `${esc(c.name)} (${c.gender === "female" ? "♀" : c.gender === "male" ? "♂" : "?"})`).join(", ");
            log(`✓ Characters: ${ch || "none found"}`, "ok");
          }
          else if (ev.type === "sheet-failed") log("⚠ Couldn't build the episode summary — translating with nearby lines as context only.", "warn");
          else if (ev.type === "batch-start") log(`Translating part ${ev.n} of ${ev.of}…`, "dim");
          else if (ev.type === "request-failed") log(`· ${label} request failed (${esc(ev.error)})${ev.willRetry ? ` — retrying in ${Math.round(ev.waitMs / 1000)}s` : ""}`, "dim");
          else if (ev.type === "carried") log(`· ${ev.count} line(s) missing from the answer — they go with the next part`, "dim");
          else if (ev.type === "foreign") log(`· ${ev.count} line(s) came back with stray non-Hebrew letters — asking again`, "dim");
          else if (ev.type === "drifted") log(`· ${ev.count} line(s) came back under the wrong line — asking again`, "dim");
          else if (ev.type === "missing") log(`· ${ev.count} line(s) missing from the answer — asking again`, "dim");
          else if (ev.type === "condense-start") log(`Shortening ${ev.count} line(s) too long to read in time…`, "dim");
          else if (ev.type === "condense-done") log(`✓ ${ev.count} line(s) shortened`, "ok");
          else if (ev.type === "stopped") log(`✗ ${label} stopped: ${esc(ev.error)}`, "err");
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
    if (outcome.translatedCues) log(`✓ ${outcome.translatedCues} cue(s) translated with ${label}`, "ok");
    if (t.rtlCheck.checked && outcome.translatedCues) log(`✓ RTL punctuation fix applied`, "ok");

    const out = TR_SRT.stringifySrt(working);
    if (working.length !== source.cues.length || !out.trim()){
      banner(t.err, "The output failed an integrity check (cue count changed). Nothing was downloaded.");
      log("✗ Integrity check failed — output discarded", "err");
      t.runBtn.disabled = false;
      return;
    }
    result = { cues: working, failedCues: failed, text: out, engine: kind, sheet: outcome.sheet, story: outcome.story };
    if (outcome.stopped && /HTTP 4(00|01|03|04)/.test(outcome.stopped) && outcome.translatedCues === 0){
      banner(t.err, `${label} refused the request: ${esc(outcome.stopped)}. Check the API key.`);
      result = null;
      t.runBtn.disabled = false;
      return;
    }
    finishRun(working, failed, attempted, outcome.translatedCues, isRetry);
  }

  function finishRun(working, failed, attempted, translatedCues, isRetry){
    const outcome = { translatedCues };
    const label = c => working[c].index || `#${c + 1}`;

    // Cues too fast to read stay on screen longer where the next cue allows.
    if (translatedCues > 0){
      const timed = working.map((c, i) => i).filter(i => working[i].index != null && working[i].timestamp != null);
      const extended = extendForReading(working, timed);
      if (extended){
        log(`✓ ${extended} fast cue(s) kept on screen longer, into the free time before the next cue`, "ok");
        result.text = TR_SRT.stringifySrt(working);
      }
    }

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
      log(`Done: ${outcome.translatedCues} cues translated — use the Download button to save the file.`, "ok");
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
    geminiSourceText, geminiLines, splitLongLine, fetchGemini, translateCuesGemini, echoMatches, hasForeignScript, stripForeignScript,
    readingBudget, extendForReading,
  };
}
