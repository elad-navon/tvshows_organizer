# Unit tests for the Extract subtitles logic in helper.py. Standard library
# only. Run from the repo root:  python -m unittest discover -s tests
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from helper import (is_hebrew_track, needs_rtl_fix, pair_videos_and_subs, rtl_fix_cues,  # noqa: E402
                    rtl_fix_line, subtitle_lang, subtitle_tracks)


def sub(index, codec="subrip", lang="eng", title="", **disp):
    return {"index": index, "codec_type": "subtitle", "codec_name": codec,
            "tags": {"language": lang, "title": title}, "disposition": disp}


def cues(*texts):
    return [{"start": i * 1000, "end": i * 1000 + 900, "rest": "", "text": t} for i, t in enumerate(texts)]


class TrackNamesTest(unittest.TestCase):
    def test_names_by_language_and_kind(self):
        tracks = subtitle_tracks("Show.S01E01", [
            {"index": 0, "codec_type": "video"},
            sub(2), sub(3, forced=1), sub(4, title="English SDH"), sub(5),
            sub(6, lang="heb"), sub(7, lang=""), sub(8, codec="hdmv_pgs_subtitle", lang="fre"),
        ])
        self.assertEqual([t["target"] for t in tracks], [
            "Show.S01E01.en.srt", "Show.S01E01.en.forced.srt", "Show.S01E01.en.sdh.srt",
            "Show.S01E01.en.2.srt", "Show.S01E01.he.srt", "Show.S01E01.und.srt", "Show.S01E01.fr.srt",
        ])
        self.assertEqual([t["index"] for t in tracks], [2, 3, 4, 5, 6, 7, 8])
        self.assertIsNone(tracks[0]["problem"])
        self.assertIn("OCR", tracks[-1]["problem"])

    def test_ass_and_mov_text_are_convertible(self):
        tracks = subtitle_tracks("A", [sub(1, codec="ass"), sub(2, codec="mov_text")])
        self.assertEqual([t["problem"] for t in tracks], [None, None])


class SubtitleLangTest(unittest.TestCase):
    def test_codes(self):
        self.assertEqual(subtitle_lang("Show.S01E01.en.srt"), "en")
        self.assertEqual(subtitle_lang("Show.S01E01.en.forced.srt"), "en")
        self.assertEqual(subtitle_lang("Show.S01E01.en.sdh.2.srt"), "en")
        self.assertEqual(subtitle_lang("Show.S01E01.heb.srt"), "he")
        self.assertIsNone(subtitle_lang("Show.S01E01.srt"))
        # Title Case words at the end of an episode name aren't language codes.
        self.assertIsNone(subtitle_lang("Show.S01E05.Just.Do.It.srt"))

    def test_pairing_ignores_extracted_english(self):
        pairs, problems = pair_videos_and_subs([
            "Show.S01E01.720p.mkv", "Show.S01E01.720p.en.srt", "show.s01e01.hebrew.srt",
        ])
        self.assertEqual(pairs, [("Show.S01E01.720p.mkv", "show.s01e01.hebrew.srt")])
        self.assertEqual(problems, [])


class RtlFixTest(unittest.TestCase):
    def test_line(self):
        self.assertEqual(rtl_fix_line("שלום, חבר."), ".שלום, חבר")
        self.assertEqual(rtl_fix_line("אתה בא או לא?!"), "?!אתה בא או לא")
        self.assertEqual(rtl_fix_line("<i>אתה בא?</i>"), "<i>?אתה בא</i>")
        self.assertEqual(rtl_fix_line("{\\an8}כן."), "{\\an8}.כן")
        self.assertEqual(rtl_fix_line("בלי פיסוק"), "בלי פיסוק")

    def test_detects_hebrew(self):
        self.assertTrue(is_hebrew_track(cues("שלום.", "<i>מה?</i>", "OK")))
        self.assertFalse(is_hebrew_track(cues("Hello.", "What?", "שלום")))

    def test_only_typed_order_is_fixed(self):
        typed = cues("שלום.", "מה קורה?", "- כן.\n- לא!", "טוב")
        self.assertTrue(needs_rtl_fix(typed))
        fixed, n = rtl_fix_cues(typed)
        self.assertEqual([c["text"] for c in fixed], [".שלום", "?מה קורה", ".- כן\n!- לא", "טוב"])
        self.assertEqual(n, 4)
        # Already fixed: running it again would move the punctuation back.
        self.assertFalse(needs_rtl_fix(fixed))


if __name__ == "__main__":
    unittest.main()
