// Unit tests for the subtitle tools. Zero dependencies — Node's built-in
// test runner. Run from the repo root:  node --test
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const srt = require("../srt-utils.js");
const tr = require("../translate.js");
const sy = require("../sync.js");

const SAMPLE = [
  "1", "00:00:01,000 --> 00:00:03,000", "Hello there, friend.", "",
  "2", "00:00:04,000 --> 00:00:06,000", "<i>Are you coming or not?!</i>", "",
  "3", "00:00:07,000 --> 00:00:10,000", "I never thought", "I'd see you again.", "",
  "4", "00:00:11,000 --> 00:00:13,000 X1:100 X2:200 Y1:10 Y2:50", "- Wait...", "- What?", "",
].join("\n");

// ---------------------------------------------------------------- srt-utils
test("parseSrt: LF, CRLF and CR inputs parse identically", () => {
  const lf = srt.parseSrt(SAMPLE);
  assert.equal(lf.cues.length, 4);
  assert.equal(lf.malformed, 0);
  assert.deepEqual(srt.parseSrt(SAMPLE.replace(/\n/g, "\r\n")), lf);
  assert.deepEqual(srt.parseSrt(SAMPLE.replace(/\n/g, "\r")), lf);
});

test("parseSrt: strips a UTF-8 BOM so cue 1 keeps its index", () => {
  const r = srt.parseSrt("﻿" + SAMPLE);
  assert.equal(r.cues[0].index, "1");
  assert.equal(r.malformed, 0);
});

test("parseSrt: multiple / whitespace-only blank lines between blocks", () => {
  const messy = SAMPLE.replace(/\n\n/g, "\n\n\n  \n\n");
  assert.equal(srt.parseSrt(messy).cues.length, 4);
});

test("parseSrt: multi-line text and tags are kept verbatim", () => {
  const { cues } = srt.parseSrt(SAMPLE);
  assert.deepEqual(cues[1].textLines, ["<i>Are you coming or not?!</i>"]);
  assert.deepEqual(cues[2].textLines, ["I never thought", "I'd see you again."]);
});

test("parseSrt: malformed blocks are kept and counted, never dropped", () => {
  const text = SAMPLE + "\njust some trailing junk\n\n5\nno timestamp here\n";
  const r = srt.parseSrt(text);
  assert.equal(r.cues.length, 6);
  assert.equal(r.malformed, 2);
  assert.deepEqual(r.cues[4].textLines, ["just some trailing junk"]);
  assert.match(srt.stringifySrt(r.cues), /just some trailing junk/);
});

test("parseSrt: empty and non-SRT input", () => {
  assert.deepEqual(srt.parseSrt(""), { cues: [], malformed: 0 });
  assert.deepEqual(srt.parseSrt("   \n\n "), { cues: [], malformed: 0 });
  const r = srt.parseSrt("this is not\na subtitle file");
  assert.equal(r.cues.filter(c => c.timestamp).length, 0);
});

test("stringifySrt: documented normalization (CRLF out), content preserved", () => {
  const out = srt.stringifySrt(srt.parseSrt(SAMPLE).cues);
  assert.ok(out.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "every newline is CRLF");
  // Same content as the input once line endings are normalized.
  assert.equal(out.replace(/\r\n/g, "\n"), SAMPLE.replace(/\n$/, "") + "\n");
  // Stable: re-parsing the output gives the same cues.
  assert.deepEqual(srt.parseSrt(out).cues, srt.parseSrt(SAMPLE).cues);
});

test("timestamps: parse and format", () => {
  assert.equal(srt.parseTimestamp("00:01:23,456"), 83456);
  assert.equal(srt.parseTimestamp("01:02:03.4"), 3723400);
  assert.equal(srt.parseTimestamp("01:23,5"), 83500);
  assert.equal(srt.parseTimestamp("83.456"), 83456);
  assert.equal(srt.parseTimestamp("-2.5"), -2500);
  assert.equal(srt.parseTimestamp("+1.5"), 1500);
  for (const bad of ["", "abc", "1:2:3", "00:61", null, undefined]) assert.equal(srt.parseTimestamp(bad), null);
  assert.equal(srt.formatTimestamp(83456), "00:01:23,456");
  assert.equal(srt.formatTimestamp(-50), "00:00:00,000");
  assert.equal(srt.formatTimestamp(36000000 + 1), "10:00:00,001");
});

test("timestamp line: positioning info after the times is preserved", () => {
  const t = srt.parseTimestampLine("00:00:11,000 --> 00:00:13,000 X1:100 X2:200 Y1:10 Y2:50");
  assert.equal(t.startMs, 11000);
  assert.equal(t.endMs, 13000);
  assert.equal(srt.formatTimestampLine(t.startMs, t.endMs, t.rest), "00:00:11,000 --> 00:00:13,000 X1:100 X2:200 Y1:10 Y2:50");
  assert.equal(srt.parseTimestampLine(null), null);
  assert.equal(srt.parseTimestampLine("not a timestamp"), null);
});

test("decodeSubtitleBytes: UTF-8 first, legacy codepage fallback", () => {
  const utf8 = Buffer.from("שלום", "utf8");
  assert.deepEqual(srt.decodeSubtitleBytes(utf8, "windows-1255"), { text: "שלום", encoding: "UTF-8" });
  const cp1255 = Buffer.from([0xF9, 0xEC, 0xE5, 0xED]); // "שלום" in Windows-1255
  assert.deepEqual(srt.decodeSubtitleBytes(cp1255, "windows-1255"), { text: "שלום", encoding: "windows-1255" });
});

// ------------------------------------------------------- RTL fix (the port)
test("fixText/fixLine match rtl_punctuation_fix.py behaviour", () => {
  assert.equal(tr.fixText("שלום, חבר."), ".שלום, חבר");      // only the trailing run moves
  assert.equal(tr.fixText("אתה בא או לא?!"), "?!אתה בא או לא"); // cluster moves as one, order kept
  assert.equal(tr.fixText("חכה..."), "...חכה");
  assert.equal(tr.fixText("רגע…"), "…רגע");
  assert.equal(tr.fixText("בלי פיסוק"), "בלי פיסוק");
  assert.equal(tr.fixText("?!"), "?!");                         // no body -> unchanged
  assert.equal(tr.fixText("  "), "");
  assert.equal(tr.fixText("\"ציטוט\""), "\"ציטוט\"");          // quotes are not in the set
  assert.equal(tr.fixLine("<i>אתה בא?</i>"), "<i>?אתה בא</i>");
  assert.equal(tr.fixLine("<font color=\"#fff\">כן.</font>"), "<font color=\"#fff\">.כן</font>");
});

// ------------------------------------------------------- cue <-> units
test("cueToUnits/unitsToLines: plain, multi-line, tags, dialogue, overrides", () => {
  let p = tr.cueToUnits(["I never thought", "I'd see you again."]);
  assert.deepEqual(p.units, ["I never thought I'd see you again."]);
  assert.deepEqual(tr.unitsToLines(p, ["מעולם לא חשבתי שאראה אותך שוב."], true), [".מעולם לא חשבתי שאראה אותך שוב"]);

  p = tr.cueToUnits(["<i>Are you coming", "or not?!</i>"]);
  assert.equal(p.wrapTag, "i");
  assert.deepEqual(p.units, ["Are you coming or not?!"]);
  assert.deepEqual(tr.unitsToLines(p, ["אתה בא או לא?!"], true), ["<i>?!אתה בא או לא</i>"]);

  p = tr.cueToUnits(["- Wait...", "- What?"]);
  assert.equal(p.dialogue, true);
  assert.deepEqual(p.units, ["Wait...", "What?"]);
  assert.deepEqual(tr.unitsToLines(p, ["חכה...", "מה?"], false), ["- חכה...", "- מה?"]);

  p = tr.cueToUnits(["{\\an8}Up top."]);
  assert.equal(p.prefix, "{\\an8}");
  assert.deepEqual(tr.unitsToLines(p, ["למעלה."], true), ["{\\an8}.למעלה"]);

  assert.equal(tr.cueToUnits(["", "   "]), null);
});

// ------------------------------------------------------- batching / markers
const seg = (t, o) => [t, o];
const MARKED = [
  seg("¶¶1¶¶\n", "¶¶1¶¶\n"),
  seg("שלום. ", "Hello. "), seg("תודה!\n", "Thanks!\n"),
  seg("¶¶2¶¶\n", "¶¶2¶¶\n"),
  seg("קצר.", "Short."),
];

test("splitBatchResponse: realigns multi-sentence cues correctly", () => {
  assert.deepEqual(tr.splitBatchResponse(MARKED, ["Hello. Thanks!", "Short."]), ["שלום. תודה!", "קצר."]);
});

test("splitBatchResponse: rejects every way the structure can go wrong", () => {
  const sent = ["Hello. Thanks!", "Short."];
  // missing marker
  assert.equal(tr.splitBatchResponse(MARKED.slice(0, 3), sent), null);
  // duplicate marker
  assert.equal(tr.splitBatchResponse([...MARKED.slice(0, 3), seg("¶¶1¶¶\n", "¶¶1¶¶\n"), seg("x", "Short.")], sent), null);
  // out of order
  assert.equal(tr.splitBatchResponse([seg("¶¶2¶¶\n", "¶¶2¶¶\n"), seg("x", "Short."), seg("¶¶1¶¶\n", "¶¶1¶¶\n"), seg("y", "Hello. Thanks!")], sent), null);
  // extra marker
  assert.equal(tr.splitBatchResponse([...MARKED, seg("¶¶3¶¶\n", "¶¶3¶¶\n"), seg("z", "Extra")], sent), null);
  // text before the first marker
  assert.equal(tr.splitBatchResponse([seg("x", "stray"), ...MARKED], sent), null);
  // original text doesn't match what was sent for that cue (would misassign)
  assert.equal(tr.splitBatchResponse(MARKED, ["Hello. Thanks!", "Something else."]), null);
  // marker merged into a text segment
  assert.equal(tr.splitBatchResponse([seg("¶¶1¶¶\nשלום.", "¶¶1¶¶\nHello."), seg("¶¶2¶¶\n", "¶¶2¶¶\n"), seg("קצר.", "Short.")], ["Hello.", "Short."]), null);
  // empty translation
  assert.equal(tr.splitBatchResponse([seg("¶¶1¶¶\n", "¶¶1¶¶\n"), seg("", "Hi.")], ["Hi."]), null);
});

test("parseGoogleResponse: shape validation", () => {
  assert.deepEqual(tr.parseGoogleResponse([[["a", "b", null]], null, "en"]), [["a", "b"]]);
  for (const bad of [null, {}, [], ["x"], [[1, 2]], "str"]) assert.equal(tr.parseGoogleResponse(bad), null);
});

test("planBatches: respects unit and size limits", () => {
  const units = Array.from({ length: 60 }, (_, i) => ({ id: i, text: "short line" }));
  const b = tr.planBatches(units);
  assert.equal(b.length, 3);
  assert.ok(b.every(x => x.length <= 25));
  const big = tr.planBatches([{ id: 0, text: "x".repeat(5000) }, { id: 1, text: "y" }]);
  assert.equal(big.length, 2);
  assert.equal(tr.buildBatchText(["A", "B"]), "¶¶1¶¶\nA\n¶¶2¶¶\nB");
});

// ------------------------------------------------------- orchestration
const fakeHebrew = t => `[he] ${t}`;
// A well-behaved fake Google that echoes markers like the real endpoint.
function goodGoogle(text){
  const segs = [];
  for (const line of text.split("\n")){
    if (/^¶¶\d+¶¶$/.test(line)) segs.push([line + "\n", line + "\n"]);
    else segs.push([fakeHebrew(line) + "\n", line + "\n"]);
  }
  return Promise.resolve({ ok: true, segments: segs });
}
const noSleep = { sleep: () => Promise.resolve(), pacingMs: 0, retryDelayMs: 0 };

test("translateUnits: happy path, empty units resolve without a request", async () => {
  let calls = 0;
  const r = await tr.translateUnits(["One.", "", "Two."], { ...noSleep, google: t => { calls++; return goodGoogle(t); } });
  assert.deepEqual(r.results, ["[he] One.", "", "[he] Two."]);
  assert.deepEqual(r.failed, []);
  assert.equal(calls, 1);
});

test("translateUnits: realign failure falls back to one-by-one, still correct", async () => {
  const google = text => text.includes("¶¶")
    ? Promise.resolve({ ok: true, segments: [["garbled", "garbled"]] })
    : goodGoogle(text);
  const r = await tr.translateUnits(["A.", "B.", "C."], { ...noSleep, google });
  assert.deepEqual(r.results, ["[he] A.", "[he] B.", "[he] C."]);
});

test("translateUnits: network errors, HTTP errors, bad JSON — retried once", async () => {
  let attempts = 0;
  const google = t => { attempts++; return attempts === 1 ? Promise.resolve({ ok: false, error: "HTTP 503" }) : goodGoogle(t); };
  const events = [];
  const r = await tr.translateUnits(["A.", "B."], { ...noSleep, google, onEvent: e => events.push(e.type) });
  assert.deepEqual(r.failed, []);
  assert.ok(events.includes("request-failed"));
  // a thrown exception inside the engine is treated like a failed request
  const r2 = await tr.translateUnits(["A."], { ...noSleep, google: () => { throw new Error("boom"); } });
  assert.deepEqual(r2.failed, [0]);
});

test("translateUnits: breaker trips, remaining units go to the local engine", async () => {
  const events = [];
  const local = { get: async () => ({ translate: async t => `[local] ${t}` }) };
  const r = await tr.translateUnits(Array.from({ length: 40 }, (_, i) => `Line ${i}.`), {
    ...noSleep, concurrency: 1,
    google: () => Promise.resolve({ ok: false, error: "timeout" }),
    local, onEvent: e => events.push(e.type),
  });
  assert.ok(r.tripped);
  assert.deepEqual(r.failed, []);
  assert.ok(r.results.every(t => t.startsWith("[local]")));
  assert.ok(r.engineOf.every(e => e === "local"));
  assert.ok(events.includes("tripped") && events.includes("local-start"));
});

test("translateUnits: no engine left -> units reported as failed, not dropped", async () => {
  const local = { get: async () => { throw new Error("not available"); } };
  const r = await tr.translateUnits(["A.", "B."], {
    ...noSleep, google: () => Promise.resolve({ ok: false, error: "HTTP 429" }), local,
  });
  assert.deepEqual(r.failed, [0, 1]);
  assert.deepEqual(r.results, [null, null]);
  assert.equal(r.localUnavailable, "not available");
});

test("translateUnits: a hung local engine is abandoned after one timeout", async () => {
  let calls = 0;
  const local = { get: async () => ({ translate: () => { calls++; return new Promise(() => {}); } }) };
  const t0 = Date.now();
  const r = await tr.translateUnits(["A.", "B.", "C."], {
    ...noSleep, google: null, local, localTimeoutMs: 20,
  });
  assert.equal(calls, 1);
  assert.deepEqual(r.failed, [0, 1, 2]);
  assert.match(r.localUnavailable, /stopped responding/);
  assert.ok(Date.now() - t0 < 1000);
});

test("translateCues: partial failure keeps the original text and lists the cue", async () => {
  const { cues } = srt.parseSrt(SAMPLE);
  // Batches fail outright (forcing one-by-one), and the cue containing
  // "Hello" keeps failing on its own; everything else succeeds.
  const google = text => (text.includes("¶¶") || text.includes("Hello"))
    ? Promise.resolve({ ok: false, error: "HTTP 500" })
    : goodGoogle(text);
  const out = await tr.translateCues(cues, [0, 1, 2, 3], true, { ...noSleep, google, maxConsecutiveFailures: 99 });
  assert.deepEqual(out.failedCues, [0]);
  assert.deepEqual(cues[0].textLines, ["Hello there, friend."]); // untouched
  assert.equal(cues[0].timestamp, "00:00:01,000 --> 00:00:03,000");
  assert.deepEqual(cues[1].textLines, ["<i>?![he] Are you coming or not</i>"]);
  assert.deepEqual(cues[3].textLines, ["...- [he] Wait", "?- [he] What"]);
  assert.equal(cues[3].timestamp, "00:00:11,000 --> 00:00:13,000 X1:100 X2:200 Y1:10 Y2:50");
  assert.equal(out.translatedCues, 3);
});

test("heOutputName", () => {
  assert.equal(tr.heOutputName("Show.S01E01.srt"), "Show.S01E01.he.srt");
  assert.equal(tr.heOutputName("Show.S01E01.en.srt"), "Show.S01E01.he.srt");
  assert.equal(tr.heOutputName("show.SRT"), "show.he.srt");
});

// ------------------------------------------------------- sync
const cuesAt = (...pairs) => pairs.map(([s, e], i) => ({
  index: String(i + 1), timestamp: srt.formatTimestampLine(s, e, ""), textLines: ["x"],
}));
const times = res => res.cues.map(c => { const t = srt.parseTimestampLine(c.timestamp); return [t.startMs, t.endMs]; });

test("parseOffset: signed seconds and signed timestamps", () => {
  assert.equal(sy.parseOffset("1.5"), 1500);
  assert.equal(sy.parseOffset("-2.3"), -2300);
  assert.equal(sy.parseOffset("+00:00:01,200"), 1200);
  assert.equal(sy.parseOffset("-01:02,500"), -62500);
  assert.equal(sy.parseOffset("- 1"), -1000);
  for (const bad of ["", "abc", "--1", "+"]) assert.equal(sy.parseOffset(bad), null);
});

test("shiftCues: positive, negative, clamping to 0", () => {
  const c = cuesAt([1000, 2000], [5000, 6000]);
  assert.deepEqual(times(sy.shiftCues(c, 1500)), [[2500, 3500], [6500, 7500]]);
  const neg = sy.shiftCues(c, -1500);
  assert.deepEqual(times(neg), [[0, 500], [3500, 4500]]);
  assert.equal(neg.clamped, 1);
  const way = sy.shiftCues(c, -10000);
  assert.deepEqual(times(way), [[0, 0], [0, 0]]);
  assert.equal(way.clamped, 4);
  assert.deepEqual(way.inverted, []);
});

test("shiftCues: inverted source durations are reported, malformed cues untouched", () => {
  const c = [...cuesAt([3000, 1000]), { index: null, timestamp: null, textLines: ["junk"] }];
  const r = sy.shiftCues(c, 1000);
  assert.deepEqual(times({ cues: [r.cues[0]] }), [[4000, 4000]]);
  assert.deepEqual(r.inverted, ["1"]);
  assert.equal(r.skipped, 1);
  assert.equal(r.cues[1], c[1]);
});

test("shiftCues: keeps positioning info", () => {
  const c = [{ index: "1", timestamp: "00:00:01,000 --> 00:00:02,000 X1:1 Y1:2", textLines: [] }];
  assert.equal(sy.shiftCues(c, 500).cues[0].timestamp, "00:00:01,500 --> 00:00:02,500 X1:1 Y1:2");
});

test("validateAnchors: blocks bad input, warns on extreme scale", () => {
  const A = (o, n) => ({ originalMs: o, correctedMs: n });
  assert.ok(sy.validateAnchors(A(null, 1), A(2, 3)).error);
  assert.ok(sy.validateAnchors(A(1000, 1000), A(1000, 5000)).error);        // identical originals
  assert.ok(sy.validateAnchors(A(1000, 5000), A(9000, 2000)).error);        // reversed -> negative scale
  assert.ok(sy.validateAnchors(A(1000, 5000), A(9000, 5000)).error);        // scale 0
  assert.ok(sy.validateAnchors(A(-1000, 0), A(9000, 9000)).error);          // negative time
  assert.ok(sy.validateAnchors(A(1000, NaN), A(9000, 9000)).error);
  const extreme = sy.validateAnchors(A(0, 0), A(1000, 5000));
  assert.ok(!extreme.error && extreme.warning && extreme.scale === 5);
  const ok = sy.validateAnchors(A(72000, 73500), A(2550000, 2553200));
  assert.ok(!ok.error && !ok.warning);
  assert.ok(Math.abs(ok.scale - (2553200 - 73500) / (2550000 - 72000)) < 1e-12);
});

test("linearCorrectCues: maps both anchors exactly, interpolates and extrapolates", () => {
  const a1 = { originalMs: 10000, correctedMs: 11000 }, a2 = { originalMs: 110000, correctedMs: 115000 };
  const { scale } = sy.validateAnchors(a1, a2);
  const r = sy.linearCorrectCues(cuesAt([10000, 12000], [60000, 61000], [110000, 111000], [0, 1000]), a1, scale);
  const t = times(r);
  assert.equal(t[0][0], 11000);
  assert.equal(t[2][0], 115000);
  assert.equal(t[1][0], 63000); // midpoint 60s -> 11 + 50*1.04 = 63s
  assert.equal(t[3][0], 600);   // before the first anchor: 11000 - 10000*1.04
  assert.ok(t.every(([s, e]) => e >= s));
});

test("linearCorrectCues: scale 1 behaves exactly like a shift", () => {
  const c = cuesAt([1000, 2000], [5000, 7000]);
  const a1 = { originalMs: 1000, correctedMs: 3000 };
  assert.deepEqual(times(sy.linearCorrectCues(c, a1, 1)), times(sy.shiftCues(c, 2000)));
});

test("linearCorrectCues: clamps negatives, never end < start", () => {
  const a1 = { originalMs: 60000, correctedMs: 1000 };
  const r = sy.linearCorrectCues(cuesAt([0, 5000], [70000, 71000]), a1, 1.0427);
  assert.ok(r.clamped >= 1);
  assert.ok(times(r).every(([s, e]) => s >= 0 && e >= s));
});

test("syncedOutputName keeps the language tag last", () => {
  assert.equal(sy.syncedOutputName("Show.S01E01.he.srt"), "Show.S01E01.synced.he.srt");
  assert.equal(sy.syncedOutputName("Show.S01E01.srt"), "Show.S01E01.synced.srt");
  assert.equal(sy.syncedOutputName("Show.S01E01.synced.he.srt"), "Show.S01E01.synced.he.srt");
  assert.equal(sy.syncedOutputName("Show.S01E01.Run.srt"), "Show.S01E01.Run.synced.srt");
});

// ------------------------------------------------------- large file
test("large file: 3,000 cues round-trip and shift quickly", () => {
  const blocks = [];
  for (let i = 0; i < 3000; i++){
    const s = i * 2000;
    blocks.push(`${i + 1}\n${srt.formatTimestampLine(s, s + 1500, "")}\nLine number ${i + 1}.`);
  }
  const text = blocks.join("\n\n") + "\n";
  const t0 = Date.now();
  const { cues, malformed } = srt.parseSrt(text);
  const shifted = sy.shiftCues(cues, 2500);
  const out = srt.stringifySrt(shifted.cues);
  assert.equal(cues.length, 3000);
  assert.equal(malformed, 0);
  assert.equal(srt.parseSrt(out).cues.length, 3000);
  assert.equal(srt.parseSrt(out).cues[2999].timestamp, srt.formatTimestampLine(5998000 + 2500, 5999500 + 2500, ""));
  assert.ok(Date.now() - t0 < 2000);
});
