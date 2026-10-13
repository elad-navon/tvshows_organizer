"use strict";

// ---------------------------------------------------------------------------
// SRT parsing / serialization, shared by the Translate and Shift tabs.
//
// Not a byte-for-byte round trip, by design: line endings are normalized to
// CRLF on output and runs of blank lines between blocks collapse to one. The
// text of every line is otherwise kept exactly as read — only the features
// that deliberately rewrite text (translation, RTL fix) change it.
// ---------------------------------------------------------------------------
const IS_INDEX_RE = /^\d+$/;
const IS_TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;
const TIMESTAMP_LINE_RE = /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(.*)$/;

// A block with neither an index nor a timestamp is kept as-is (it still
// round-trips into the output) but counted, so callers can report it rather
// than letting it vanish silently. A block with an index but no timestamp
// (or vice versa) is equally unusable for timing, so it counts as malformed.
function parseSrt(raw){
  const text = String(raw).replace(/^﻿/, "").replace(/\r\n|\r/g, "\n");
  const cues = [];
  let malformed = 0;
  if (!text.trim()) return { cues, malformed };
  for (const block of text.trim().split(/\n[ \t]*\n+/)){
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let i = 0;
    const index = IS_INDEX_RE.test((lines[0] || "").trim()) ? lines[i++].trim() : null;
    const timestamp = IS_TIMESTAMP_RE.test(lines[i] || "") ? lines[i++] : null;
    if (index == null || timestamp == null) malformed++;
    cues.push({ index, timestamp, textLines: lines.slice(i) });
  }
  return { cues, malformed };
}

function stringifySrt(cues){
  const blocks = cues.map(c =>
    [c.index, c.timestamp, ...c.textLines].filter(l => l != null).join("\r\n"));
  return blocks.join("\r\n\r\n") + "\r\n";
}

// Accepts "hh:mm:ss,ms", "mm:ss,ms" (comma or dot) or plain signed seconds
// ("83.456", "-2.5", "+1.5"). Returns milliseconds, or null if unparseable.
function parseTimestamp(input){
  const ts = String(input == null ? "" : input).trim();
  let m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts);
  if (m) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Number(m[4].padEnd(3, "0"));
  m = /^(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(ts);
  if (m) return (+m[1] * 60 + +m[2]) * 1000 + Number(m[3].padEnd(3, "0"));
  if (/^[+-]?\d+(\.\d+)?$/.test(ts)){
    const ms = Math.round(parseFloat(ts) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function formatTimestamp(ms){
  let rem = Math.max(0, Math.round(ms));
  const h = Math.floor(rem / 3600000); rem -= h * 3600000;
  const m = Math.floor(rem / 60000); rem -= m * 60000;
  const s = Math.floor(rem / 1000); rem -= s * 1000;
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(rem, 3)}`;
}

// `rest` keeps anything after the end time (e.g. "X1:100 X2:200 Y1:..").
function parseTimestampLine(line){
  const m = TIMESTAMP_LINE_RE.exec(line || "");
  if (!m) return null;
  return { startMs: parseTimestamp(m[1]), endMs: parseTimestamp(m[2]), rest: m[3] || "" };
}

function formatTimestampLine(startMs, endMs, rest){
  return `${formatTimestamp(startMs)} --> ${formatTimestamp(endMs)}${rest || ""}`;
}

// Strict UTF-8 first; if the bytes aren't valid UTF-8, fall back to the given
// legacy codepage (windows-1252 for English sources, windows-1255 for Hebrew).
function decodeSubtitleBytes(buffer, fallbackEncoding){
  try{
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" };
  } catch(e){
    return { text: new TextDecoder(fallbackEncoding).decode(buffer), encoding: fallbackEncoding };
  }
}

// UTF-8 with BOM: the common convention for Hebrew/RTL subtitle files, which
// some players otherwise mis-detect as a legacy codepage.
function downloadTextFile(filename, text){
  const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function srtStem(filename){
  return String(filename).replace(/\.srt$/i, "");
}

if (typeof module !== "undefined" && module.exports){
  module.exports = {
    parseSrt, stringifySrt, parseTimestamp, formatTimestamp,
    parseTimestampLine, formatTimestampLine, srtStem, decodeSubtitleBytes,
    IS_INDEX_RE, IS_TIMESTAMP_RE,
  };
}
