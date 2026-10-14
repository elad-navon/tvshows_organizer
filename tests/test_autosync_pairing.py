# Unit tests for the Auto Sync file pairing in helper.py. Standard library
# only. Run from the repo root:  python -m unittest discover -s tests
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from helper import episode_tag, pair_videos_and_subs  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
