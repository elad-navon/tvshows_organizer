# Unit tests for the Auto Sync file pairing in helper.py. Standard library
# only. Run from the repo root:  python -m unittest discover -s tests
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from helper import (break_chunks, choose_reference, decode_srt, episode_tag, find_unmarked_break,  # noqa: E402
                    format_srt, infer_break_chunks, is_break_marker, pair_videos_and_subs, parse_srt,
                    tidy_synced_cues)


class EpisodeTagTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(episode_tag("Girls.S01E02.720p.HDTV.x264-AVS.mkv"), "S01E02")
        self.assertEqual(episode_tag("show.s1e5.srt"), "S01E05")
        self.assertEqual(episode_tag("Show 2x07.srt"), "S02E07")

    def test_codec_and_resolution_are_not_tags(self):
        self.assertIsNone(episode_tag("Movie.1080p.x264.mkv"))


class PairingTest(unittest.TestCase):
    def test_exact_stem(self):
        pairs, problems = pair_videos_and_subs(["A.S01E01.mkv", "A.S01E01.srt"])
        self.assertEqual(pairs, [("A.S01E01.mkv", "A.S01E01.srt")])
        self.assertEqual(problems, [])

    def test_he_srt(self):
        pairs, _ = pair_videos_and_subs(["A.S01E01.mkv", "A.S01E01.he.srt"])
        self.assertEqual(pairs, [("A.S01E01.mkv", "A.S01E01.he.srt")])

    def test_episode_tag_fallback(self):
        pairs, problems = pair_videos_and_subs([
            "Girls.S01E02.720p.HDTV.x264-AVS.mkv", "girls.s01e02.hebrew.srt",
            "Girls.S01E05.1080p.BluRay.mkv", "Girls.1x05.srt",
        ])
        self.assertEqual(pairs, [
            ("Girls.S01E02.720p.HDTV.x264-AVS.mkv", "girls.s01e02.hebrew.srt"),
            ("Girls.S01E05.1080p.BluRay.mkv", "Girls.1x05.srt"),
        ])
        self.assertEqual(problems, [])

    def test_exact_match_claims_its_srt_before_fallback(self):
        # B's S01E01 subtitle belongs to B's video, so A can't borrow it.
        pairs, problems = pair_videos_and_subs(["A.S01E01.mkv", "B.S01E01.mkv", "B.S01E01.srt"])
        self.assertEqual(pairs, [("B.S01E01.mkv", "B.S01E01.srt")])
        self.assertEqual([v for v, _ in problems], ["A.S01E01.mkv"])

    def test_ambiguous_fallback_is_skipped(self):
        pairs, problems = pair_videos_and_subs(["A.S01E01.mkv", "x.S01E01.srt", "y.S01E01.srt"])
        self.assertEqual(pairs, [])
        self.assertIn("more than one", problems[0][1])

    def test_both_exact_names_is_ambiguous(self):
        pairs, problems = pair_videos_and_subs(["A.S01E01.mkv", "A.S01E01.srt", "A.S01E01.he.srt"])
        self.assertEqual(pairs, [])
        self.assertEqual(len(problems), 1)

    def test_missing_subtitle(self):
        pairs, problems = pair_videos_and_subs(["A.S01E03.mkv", "A.S01E04.srt"])
        self.assertEqual(pairs, [])
        self.assertIn("no S01E03 subtitle", problems[0][1])

    def test_non_video_files_are_ignored(self):
        pairs, problems = pair_videos_and_subs(["notes.txt", "A.S01E01.nfo", "A.S01E01.srt", "_original_subs"])
        self.assertEqual(pairs, [])
        self.assertEqual(problems, [])


def _stream(kind, codec, lang=None, title=None, forced=0):
    tags = {k: v for k, v in (("language", lang), ("title", title)) if v}
    return {"codec_type": kind, "codec_name": codec, "tags": tags, "disposition": {"forced": forced}}


class ReferenceTest(unittest.TestCase):
    def test_english_text_subtitle_wins(self):
        streams = [_stream("video", "hevc"), _stream("audio", "ac3", "ita"), _stream("audio", "ac3", "eng"),
                   _stream("subtitle", "subrip", "ita"), _stream("subtitle", "subrip", "eng")]
        self.assertEqual(choose_reference(streams)[0], "s:1")

    def test_forced_and_bitmap_subtitles_are_skipped(self):
        streams = [_stream("audio", "ac3", "ita"), _stream("audio", "ac3", "eng"),
                   _stream("subtitle", "subrip", "eng", "English Forced"),
                   _stream("subtitle", "subrip", "eng", forced=1),
                   _stream("subtitle", "hdmv_pgs_subtitle", "eng")]
        self.assertEqual(choose_reference(streams)[0], "a:1")

    def test_no_english_falls_back_to_default_audio(self):
        streams = [_stream("audio", "aac", "ita"), _stream("subtitle", "subrip", "ita")]
        self.assertIsNone(choose_reference(streams)[0])
        self.assertIsNone(choose_reference([])[0])


def _cue(start, end, text):
    return {"start": start, "end": end, "rest": "", "text": text}


class TidyCuesTest(unittest.TestCase):
    def test_swapped_cues_go_back_to_source_order(self):
        # A section jump moved "B" before "A" (ffsubsync sorts by start).
        source = [_cue(0, 1000, "A"), _cue(1100, 2000, "B"), _cue(9000, 9500, "C")]
        synced = [_cue(500, 1500, "B"), _cue(700, 1800, "A"), _cue(9000, 9500, "C")]
        cues, fixed, _ = tidy_synced_cues(source, synced)
        self.assertEqual([c["text"] for c in cues], ["A", "B", "C"])
        self.assertEqual(fixed, 1)
        # B moves into the free time after it, keeping its length.
        self.assertEqual((cues[0]["start"], cues[0]["end"]), (700, 1800))
        self.assertEqual((cues[1]["start"], cues[1]["end"]), (1840, 2840))

    def test_no_room_shortens_earlier_cue_then_pushes(self):
        # No overlap in the source: the sync moved B and C back 1.1s into A.
        source = [_cue(0, 3000, "A"), _cue(3100, 4100, "B"), _cue(4200, 5100, "C")]
        synced = [source[0], _cue(2000, 3000, "B"), _cue(3100, 4000, "C")]
        cues, fixed, _ = tidy_synced_cues(source, synced)
        self.assertEqual(cues[0]["end"], 1960)  # A shortened, still readable
        self.assertEqual(cues[1]["start"], 2000)
        for prev, cur in zip(cues, cues[1:]):
            self.assertGreaterEqual(cur["start"], prev["end"])

    def test_never_shortens_below_minimum(self):
        source = [_cue(0, 2000, "A"), _cue(2100, 3000, "B")]
        cues, _, _ = tidy_synced_cues(source, [source[0], _cue(100, 1000, "B")])
        self.assertEqual(cues[0]["end"], 2000)       # last cue: nothing after B, so B moves
        self.assertEqual(cues[1]["start"], 2040)

    def test_translators_own_overlap_is_kept(self):
        source = [_cue(0, 2000, "A"), _cue(1500, 3000, "B"), _cue(9000, 9500, "C")]
        synced = [_cue(c["start"] + 400, c["end"] + 400, c["text"]) for c in source]
        cues, fixed, _ = tidy_synced_cues(source, synced)
        self.assertEqual(fixed, 0)
        self.assertEqual((cues[1]["start"], cues[1]["end"]), (1900, 3400))

    def test_changed_text_keeps_synced_order(self):
        cues, fixed, _ = tidy_synced_cues([_cue(0, 1000, "X")], [_cue(0, 1000, "A"), _cue(2000, 3000, "B")])
        self.assertEqual([c["text"] for c in cues], ["A", "B"])
        self.assertEqual(fixed, 0)

    def test_island_section_gets_its_neighbours_offset(self):
        # 30 cues 3s apart; cues 10-14 were moved 55s back, the rest by -1s / -2.5s.
        source = [_cue(i * 3000, i * 3000 + 2000, f"line {i}") for i in range(30)]
        shift = lambda i: -55000 if 10 <= i <= 14 else (-1000 if i < 20 else -2500)
        synced = sorted((_cue(c["start"] + shift(i), c["end"] + shift(i), c["text"]) for i, c in enumerate(source)),
                        key=lambda c: c["start"])
        cues, _, islands = tidy_synced_cues(source, synced)
        self.assertEqual(islands, 1)
        self.assertEqual([c["text"] for c in cues], [c["text"] for c in source])
        self.assertEqual(cues[12]["start"], source[12]["start"] - 1000)

    def test_real_cut_is_not_an_island(self):
        # The offset changes for good at cue 15: a cut, not a misdetection.
        source = [_cue(i * 3000, i * 3000 + 2000, f"line {i}") for i in range(30)]
        synced = [_cue(c["start"] - (0 if i < 15 else 20000), c["end"] - (0 if i < 15 else 20000), c["text"])
                  for i, c in enumerate(source)]
        _, _, islands = tidy_synced_cues(source, sorted(synced, key=lambda c: c["start"]))
        self.assertEqual(islands, 0)

    def test_section_boundary_snaps_to_break_marker(self):
        # A 2s ad-break gap holding a "+" cue after line 19, but ffsubsync
        # started the -2s section at line 12 instead.
        source, t = [], 0
        for i in range(40):
            if i == 20:
                source.append(_cue(t, t + 500, "+"))
                t += 2500
            source.append(_cue(t, t + 2000, f"line {i}"))
            t += 2500
        texts = [c for c in source if c["text"] != "+"]
        synced = [_cue(c["start"] - (2000 if i >= 12 else 0), c["end"] - (2000 if i >= 12 else 0), c["text"])
                  for i, c in enumerate(texts)]
        cues, _, _ = tidy_synced_cues(source, sorted(synced, key=lambda c: c["start"]))
        by_text = {c["text"]: c for c in cues}
        orig = {c["text"]: c for c in texts}
        self.assertEqual(by_text["line 15"]["start"], orig["line 15"]["start"])        # back to the earlier offset
        self.assertEqual(by_text["line 25"]["start"], orig["line 25"]["start"] - 2000)  # after the break: unchanged


class BreakChunksTest(unittest.TestCase):
    def test_split_at_marks_and_drop_them(self):
        cues = [_cue(0, 1, "a"), _cue(2, 3, "+"), _cue(4, 5, "b"), _cue(6, 7, " + "), _cue(8, 9, "c")]
        self.assertEqual([[c["text"] for c in part] for part in break_chunks(cues)], [["a"], ["b"], ["c"]])

    def test_no_marks_means_no_parts(self):
        self.assertIsNone(break_chunks([_cue(0, 1, "a"), _cue(2, 3, "b")]))
        self.assertIsNone(break_chunks([_cue(0, 1, "+"), _cue(2, 3, "a")]))  # a mark at the very start splits nothing

    def test_marks_in_italics_or_repeated(self):
        for text in ("+", "+++", "<i>+++</i>", " * ", "##"):
            self.assertTrue(is_break_marker(text), text)
        for text in ("+ yes", "2+2", "++++++", ""):
            self.assertFalse(is_break_marker(text), text)

    def test_steps_in_split_result_become_parts_at_the_longest_gap(self):
        # 100 lines 3s apart, a 6s gap after line 49; ffsubsync stepped the
        # offset from 0 to -2s at line 46, with a noisy line thrown far away.
        source, t = [], 0
        for i in range(100):
            t += 6000 if i == 50 else 3000
            source.append(_cue(t, t + 2000, f"line {i}"))
        shift = lambda i: 40000 if i == 70 else (0 if i < 46 else -2000)
        synced = [_cue(c["start"] + shift(i), c["end"] + shift(i), c["text"]) for i, c in enumerate(source)]
        parts, centers = infer_break_chunks(source, sorted(synced, key=lambda c: c["start"]))
        self.assertEqual([len(p) for p in parts], [50, 50])
        self.assertEqual(centers, [0, -2000])

    def test_steady_offset_gives_no_parts(self):
        source = [_cue(i * 3000, i * 3000 + 2000, f"line {i}") for i in range(100)]
        self.assertIsNone(infer_break_chunks(source, [dict(c) for c in source]))


def _fake_ffsubsync(true_offset):
    """Stands in for ffsubsync and the speech: a part aligns at its lines'
    most common true offset (if inside the window), and a line fits the
    speech only at its own true offset."""
    def measure(cues, center, window_s):
        offsets = [true_offset(c) for c in cues]
        best = max(set(offsets), key=offsets.count)
        return best if abs(best - center) <= window_s * 1000 else None
    def fit(cue, offset):
        return cue["end"] - cue["start"] if offset == true_offset(cue) else 0
    return measure, fit


class UnmarkedBreakTest(unittest.TestCase):
    def setUp(self):
        self.chunk = [_cue(i * 3000, i * 3000 + 2000, f"line {i}") for i in range(120)]

    def test_break_is_placed_where_the_offset_changes(self):
        cut = self.chunk[70]["start"]
        measure, fit = _fake_ffsubsync(lambda c: 7800 if c["start"] < cut else 11800)
        self.assertEqual(find_unmarked_break(self.chunk, 11300, measure, fit), (70, 7800, 11800))

    def test_break_near_the_end_of_the_part(self):
        cut = self.chunk[95]["start"]
        measure, fit = _fake_ffsubsync(lambda c: 0 if c["start"] < cut else -3000)
        self.assertEqual(find_unmarked_break(self.chunk, 0, measure, fit), (95, 0, -3000))

    def test_one_offset_means_no_break(self):
        self.assertIsNone(find_unmarked_break(self.chunk, 7000, *_fake_ffsubsync(lambda c: 7800)))

    def test_short_part_is_left_alone(self):
        measure, fit = _fake_ffsubsync(lambda c: 0 if c["start"] < self.chunk[25]["start"] else 4000)
        self.assertIsNone(find_unmarked_break(self.chunk[:50], 0, measure, fit))

    def test_a_third_measured_far_off_is_not_a_break(self):
        _, fit = _fake_ffsubsync(lambda c: 0)
        noisy = lambda cues, center, window_s: 4000 if cues[0]["start"] >= self.chunk[80]["start"] else 0
        self.assertIsNone(find_unmarked_break(self.chunk, 0, noisy, fit))


class SrtRoundTripTest(unittest.TestCase):
    def test_parse_and_format(self):
        text = ("1\r\n00:00:01,066 --> 00:00:02,206\r\nשלום\r\nעולם\r\n\r\n"
                "2\r\n01:02:03,004 --> 01:02:04,000\r\n+\r\n")
        cues = parse_srt(text)
        self.assertEqual(cues[0], {"start": 1066, "end": 2206, "rest": "", "text": "שלום\nעולם"})
        self.assertEqual(cues[1]["start"], 3723004)
        self.assertEqual(format_srt(cues), text)

    def test_unreadable_block_means_hands_off(self):
        self.assertIsNone(parse_srt("1\nnot a timing line\nhello\n"))

    def test_stray_fragment_joins_the_cue_before(self):
        cues = parse_srt("1\n00:00:01,000 --> 00:00:02,000\n<i>+++</i>\n\ni>\n")
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0]["text"], "<i>+++</i>\ni>")

    def test_decode_windows_1255(self):
        self.assertEqual(decode_srt("שלום".encode("cp1255")), "שלום")


if __name__ == "__main__":
    unittest.main()
