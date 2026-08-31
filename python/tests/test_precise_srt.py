from __future__ import annotations

import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from koubox_runtime.precise_srt import (
    TimedWord,
    _punctuated_text_from_words,
    _split_aligned_word_by_tokens,
    enforce_aligned_word_limits,
    apply_builtin_terminology,
    apply_builtin_terminology_to_words,
    assess_speech_rate,
    choose_multirate_candidate,
    classify_pause,
    format_display_text,
    repair_zero_duration_segments,
    repair_zero_duration_words,
    prepare_alignment_text,
    validate_request,
)
from koubox_runtime.precise_srt_retry import (
    apply_retry_decisions_to_punctuated_text,
    choose_full_speed_candidate,
    find_suspicious_spans,
    map_speed_words_to_original_time,
    replace_retry_spans_with_timed_candidates,
    select_timed_candidate,
)
from koubox_runtime.precise_srt_segmentation import segment_words
from koubox_runtime.precise_srt_worker import run


class PreciseSrtContractTests(unittest.TestCase):
    def test_mode_b_rejects_reference_text(self) -> None:
        with self.assertRaisesRegex(ValueError, "无文案模式"):
            validate_request(
                mode="asr-only",
                language="ja",
                speech_rate_mode="auto",
                source_text="参考文案不得进入推理",
            )

    def test_pause_tiers_match_product_contract(self) -> None:
        self.assertEqual(classify_pause(0.15), "soft")
        self.assertEqual(classify_pause(0.30), "medium")
        self.assertEqual(classify_pause(0.50), "hard")
        self.assertIsNone(classify_pause(0.10))

    def test_multirate_candidate_requires_two_votes_and_probability_gain(self) -> None:
        accepted = choose_multirate_candidate(
            original_text="一時情報",
            original_probability=0.40,
            candidates=[
                ("一次情報", 0.58, "1.0"),
                ("一次情報", 0.62, "0.90"),
                ("一時情報", 0.51, "0.80"),
            ],
        )
        self.assertEqual(accepted.text, "一次情報")
        self.assertTrue(accepted.applied)

        different_length = choose_multirate_candidate(
            original_text="元リュウ",
            original_probability=0.30,
            candidates=[
                ("下流", 0.56, "1.0"),
                ("下流", 0.60, "0.90"),
                ("元リュウ", 0.45, "0.80"),
            ],
        )
        self.assertEqual(different_length.text, "下流")
        self.assertTrue(different_length.applied)

        pathological_expansion = choose_multirate_candidate(
            original_text="市場",
            original_probability=0.30,
            candidates=[
                ("市場全体を説明する非常に長い候補文章", 0.90, "1.0"),
                ("市場全体を説明する非常に長い候補文章", 0.92, "0.90"),
            ],
        )
        self.assertFalse(pathological_expansion.applied)

        rejected = choose_multirate_candidate(
            original_text="市場",
            original_probability=0.70,
            candidates=[
                ("市場", 0.75, "1.0"),
                ("市上", 0.78, "0.90"),
                ("市場", 0.76, "0.80"),
            ],
        )
        self.assertEqual(rejected.text, "市場")
        self.assertFalse(rejected.applied)

    def test_low_confidence_characters_are_grouped_into_a_phrase(self) -> None:
        words = [
            TimedWord("工", 0.0, 0.1, 0.95),
            TimedWord("場", 0.1, 0.2, 0.20),
            TimedWord("設", 0.2, 0.3, 0.96),
            TimedWord("備", 0.3, 0.4, 0.30, "medium"),
        ]
        spans = find_suspicious_spans(words, threshold=0.55, maximum_spans=6)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].text, "工場設備")
        self.assertEqual((spans[0].start_index, spans[0].end_index), (0, 3))

    def test_timed_candidate_accounts_for_atempo_scale(self) -> None:
        candidate = select_timed_candidate(
            [
                TimedWord("前", 0.2, 0.8, 0.9),
                TimedWord("工場設備", 1.2, 2.0, 0.8),
                TimedWord("後", 2.2, 2.8, 0.9),
            ],
            crop_start=3.0,
            span_start=4.0,
            span_end=4.6,
            speed=0.8,
            language="ja",
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate[0], "工場設備")
        self.assertEqual(candidate[1], 0.8)

    def test_full_speed_words_map_back_to_original_audio_time(self) -> None:
        mapped = map_speed_words_to_original_time(
            [TimedWord("高速", 1.0, 2.0, 0.8, "medium")],
            0.8,
        )
        self.assertEqual(mapped, [TimedWord("高速", 0.8, 1.6, 0.8, "medium")])

    def test_full_speed_candidate_requires_extreme_rate_and_two_route_consensus(self) -> None:
        original = [TimedWord("元リュウ", 0.0, 1.0, 0.60)]
        candidates = {
            "full-0.90": [TimedWord("下流", 0.0, 1.0, 0.75)],
            "full-0.80": [TimedWord("下流", 0.0, 1.0, 0.77)],
        }
        selected = choose_full_speed_candidate(
            units_per_second=14.1,
            threshold=7.0,
            original_words=original,
            candidates=candidates,
            language="ja",
        )
        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual("".join(word.text for word in selected[1]), "下流")

        no_consensus = choose_full_speed_candidate(
            units_per_second=14.1,
            threshold=7.0,
            original_words=original,
            candidates={
                "full-0.90": [TimedWord("下流", 0.0, 1.0, 0.75)],
                "full-0.80": [TimedWord("元リュウ", 0.0, 1.0, 0.77)],
            },
            language="ja",
        )
        self.assertIsNone(no_consensus)

        not_extreme = choose_full_speed_candidate(
            units_per_second=11.7,
            threshold=7.0,
            original_words=original,
            candidates=candidates,
            language="ja",
        )
        self.assertIsNone(not_extreme)

    def test_context_rule_does_not_replace_word_globally(self) -> None:
        unchanged, changes = apply_builtin_terminology("元リュウを確認した", "ja")
        self.assertEqual(unchanged, "元リュウを確認した")
        self.assertEqual(changes, [])

        corrected, changes = apply_builtin_terminology("元リュウの導入計画", "ja")
        self.assertEqual(corrected, "下流の導入計画")
        self.assertEqual(len(changes), 1)

        temperature, changes = apply_builtin_terminology("水温を測る", "ja")
        self.assertEqual(temperature, "水温を測る")
        self.assertEqual(changes, [])

        timed = apply_builtin_terminology_to_words(
            [
                TimedWord("元", 0.0, 0.1, 0.8),
                TimedWord("リュウ", 0.1, 0.3, 0.8),
                TimedWord("の導入計画", 0.3, 0.8, 0.9),
            ],
            "ja",
        )
        self.assertEqual("".join(word.text for word in timed), "下流の導入計画")
        self.assertEqual((timed[0].start, timed[0].end), (0.0, 0.8))

    def test_speed_sample_context_rules_are_scoped(self) -> None:
        corrected, changes = apply_builtin_terminology(
            "カメラホールドガイズリ車両 電報機器の近く 振り込みソフトが必要です",
            "ja",
        )
        self.assertIn("カメラ工場設備車両", corrected)
        self.assertIn("店舗機器の近く", corrected)
        self.assertIn("組み込みソフトが必要です", corrected)
        self.assertEqual(len(changes), 3)

    def test_fast_sample_terms_cover_high_frequency_context_errors(self) -> None:
        text = (
            "AIの次の競争は巨大な戦略だけで完結しないかもしれません"
            "カメラホールド開発機車両 現場処理には静音チップ"
            "何のコストを求め 評価の根拠が上げます"
            "公開情報チェックコンボを提示します 特定映画の売買推奨"
            "数字の証拠が重要です"
        )
        corrected, _ = apply_builtin_terminology(text, "ja")
        for expected in (
            "巨大データセンター",
            "カメラ工場設備車両",
            "推論チップ",
            "コストを下げ",
            "根拠が見えます",
            "チェック項目を整理します",
            "特定銘柄の売買推奨",
            "数字との照合が重要です",
        ):
            self.assertIn(expected, corrected)

    def test_speech_rate_is_language_specific(self) -> None:
        chinese = assess_speech_rate(
            "快速语音识别测试",
            language="zh",
            voiced_duration_s=1.0,
            mean_probability=0.60,
            low_confidence_ratio=0.20,
        )
        english = assess_speech_rate(
            "this is a fast speech recognition test",
            language="en",
            voiced_duration_s=1.0,
            mean_probability=0.60,
            low_confidence_ratio=0.20,
        )
        self.assertEqual(chinese.units, 8)
        self.assertEqual(english.units, 7)
        self.assertTrue(chinese.should_retry)
        self.assertTrue(english.should_retry)

        overconfident_fast = assess_speech_rate(
            "高速音声でも確率だけを信用しない",
            language="ja",
            voiced_duration_s=1.0,
            mean_probability=0.94,
            low_confidence_ratio=0.01,
        )
        self.assertTrue(overconfident_fast.should_retry)

        borderline_normal = assess_speech_rate(
            "あ" * 12,
            language="ja",
            voiced_duration_s=1.0,
            mean_probability=0.944,
            low_confidence_ratio=0.041,
        )
        self.assertFalse(borderline_normal.should_retry)

    def test_japanese_segmentation_never_splits_compound_or_particle(self) -> None:
        words = [
            TimedWord("スマート", 0.0, 0.4, 0.9),
            TimedWord("工場", 0.4, 0.8, 0.9),
            TimedWord("では", 0.8, 1.0, 0.9),
            TimedWord("重要", 1.0, 1.4, 0.9),
            TimedWord("です", 1.4, 1.7, 0.9),
        ]
        segments = segment_words(words, language="ja", pauses=[(0.95, 1.0)])
        texts = [segment["text"] for segment in segments]
        self.assertEqual("".join(texts), "スマート工場では重要です")
        self.assertNotIn("スマート", texts)
        self.assertNotIn("です", texts)

    def test_pause_evidence_is_limited_to_the_actual_aligned_gap(self) -> None:
        words = [
            TimedWord("気", 0.0, 0.40, 0.9),
            TimedWord("に", 0.44, 0.50, 0.9),
            TimedWord("なる", 0.50, 0.90, 0.9),
            TimedWord("人", 0.90, 1.10, 0.9),
            TimedWord("は", 1.10, 1.20, 0.9),
        ]
        segments = segment_words(
            words,
            language="ja",
            pauses=[(0.30, 0.60)],
        )
        texts = [str(item["text"]) for item in segments]
        self.assertEqual("".join(texts), "気になる人は")
        self.assertNotIn("気", texts)
        self.assertNotIn("に", texts)

    def test_vad_uses_relative_gain_for_quiet_recordings(self) -> None:
        import tempfile
        import numpy as np
        import soundfile as sf
        from koubox_runtime.precise_srt_retry import _detect_pauses

        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/quiet.wav"
            t = np.linspace(0, 1.0, 16000, endpoint=False)
            samples = (0.02 * np.sin(2 * np.pi * 220 * t)).astype("float32")
            sf.write(path, samples, 16000)
            pauses, duration, voiced = _detect_pauses(path)
        self.assertEqual(pauses, [])
        self.assertAlmostEqual(duration, 1.0, places=2)
        self.assertGreater(voiced, 0.9)

    def test_japanese_modifier_attaches_to_following_noun(self) -> None:
        segments = segment_words(
            [
                TimedWord("この", 0.0, 0.2, 0.9),
                TimedWord("テーマ", 0.2, 0.7, 0.9),
                TimedWord("です", 0.7, 1.0, 0.9),
            ],
            language="ja",
            pauses=[],
        )
        self.assertNotIn("この", [str(item["text"]) for item in segments])

    def test_japanese_alignment_text_exposes_morphological_boundaries(self) -> None:
        prepared = prepare_alignment_text("半導体資料が強くても特定分野。", "ja")
        self.assertIn(" ", prepared)
        self.assertEqual(
            format_display_text(prepared).replace(" ", ""),
            "半導体資料が強くても特定分野",
        )

    def test_source_punctuation_is_a_segmentation_hint_but_not_display_text(self) -> None:
        segments = segment_words(
            [
                TimedWord("数字", 0.0, 0.4, 0.9, "medium"),
                TimedWord("社名", 0.4, 0.8, 0.9, "medium"),
                TimedWord("ニュース", 0.8, 1.4, 0.9),
            ],
            language="ja",
            pauses=[],
        )
        self.assertEqual([item["text"] for item in segments], ["数字", "社名", "ニュース"])

    def test_non_japanese_punctuation_survives_atomic_unit_normalization(self) -> None:
        segments = segment_words(
            [
                TimedWord("第一句", 0.0, 0.4, 0.9, "hard"),
                TimedWord("第二句", 0.4, 0.8, 0.9),
            ],
            language="zh",
            pauses=[],
        )
        self.assertEqual([item["text"] for item in segments], ["第一句", "第二句"])

    def test_english_apostrophe_is_preserved(self) -> None:
        self.assertEqual(format_display_text("don't"), "don't")

    def test_ascii_display_punctuation_is_removed_consistently(self) -> None:
        self.assertEqual(format_display_text("hello, world."), "hello world")

    def test_english_full_speed_text_preserves_word_spaces(self) -> None:
        text = _punctuated_text_from_words(
            [
                TimedWord("edge", 0.0, 0.3, 0.9),
                TimedWord("computing", 0.3, 0.8, 0.9, "hard"),
            ],
            "en",
        )
        self.assertEqual(text, "edge computing.")
        korean = _punctuated_text_from_words(
            [
                TimedWord("엣지", 0.0, 0.3, 0.9),
                TimedWord("컴퓨팅", 0.3, 0.8, 0.9, "hard"),
            ],
            "ko",
        )
        self.assertEqual(korean, "엣지 컴퓨팅.")

    def test_chinese_english_and_korean_keep_atomic_words(self) -> None:
        cases = [
            ("zh", [TimedWord("边缘感知", 0.0, 0.8, 0.9), TimedWord("系统", 0.9, 1.3, 0.9)], "边缘感知系统"),
            ("en", [TimedWord("edge", 0.0, 0.3, 0.9), TimedWord("computing", 0.3, 0.8, 0.9)], "edge computing"),
            ("ko", [TimedWord("엣지", 0.0, 0.3, 0.9), TimedWord("컴퓨팅", 0.3, 0.8, 0.9)], "엣지 컴퓨팅"),
        ]
        for language, words, expected in cases:
            with self.subTest(language=language):
                segments = segment_words(words, language=language, pauses=[])
                self.assertEqual("".join(item["text"] for item in segments), expected)

    def test_zero_duration_cluster_is_repaired(self) -> None:
        repaired = repair_zero_duration_segments(
            [
                {"text": "前", "start": 1.0, "end": 1.0},
                {"text": "後続", "start": 1.0, "end": 1.6},
            ]
        )
        self.assertEqual(len(repaired), 1)
        self.assertEqual(repaired[0]["text"], "前後続")
        self.assertGreater(repaired[0]["end"], repaired[0]["start"])
        self.assertEqual(repaired[-1]["end"], 1.6)

    def test_zero_duration_words_merge_into_real_acoustic_span(self) -> None:
        repaired = repair_zero_duration_words(
            [
                TimedWord("前", 0.0, 0.5, 0.9),
                TimedWord("置", 0.5, 0.5, None),
                TimedWord("後", 0.5, 1.0, 0.9),
            ]
        )
        self.assertEqual(
            repaired,
            [
                TimedWord("前置", 0.0, 0.5, 0.9),
                TimedWord("後", 0.5, 1.0, 0.9),
            ],
        )

    def test_oversized_phrase_splits_only_on_aligned_word_boundaries(self) -> None:
        words = [
            TimedWord("スマート", 0.0, 0.7, 0.9),
            TimedWord("製造", 0.7, 1.2, 0.9),
            TimedWord("システム", 1.2, 1.9, 0.9),
            TimedWord("高速", 1.9, 2.2, 0.9),
            TimedWord("向け", 2.2, 2.5, 0.9),
            TimedWord("です", 2.5, 2.9, 0.9),
        ]
        segments = segment_words(words, language="ja", pauses=[])
        self.assertEqual("".join(item["text"] for item in segments), "スマート製造システム高速向けです")
        self.assertGreater(len(segments), 1)
        for item in segments:
            self.assertLessEqual(len(str(item["text"])), 14)
            self.assertLessEqual(float(item["end"]) - float(item["start"]), 3.0)

    def test_oversized_alignment_fallback_uses_complete_janome_tokens(self) -> None:
        split = _split_aligned_word_by_tokens(
            TimedWord("店舗機器の近くで判断するエッジ", 1.0, 2.0, 0.8),
            ["店舗", "機器", "の", "近く", "で", "判断", "する", "エッジ"],
        )
        self.assertEqual([word.text for word in split], ["店舗", "機器", "の", "近く", "で", "判断", "する", "エッジ"])
        self.assertAlmostEqual(split[0].start, 1.0)
        self.assertAlmostEqual(split[-1].end, 2.0)
        self.assertTrue(all(word.end > word.start for word in split))

    def test_final_word_limit_enforcement_runs_after_zero_duration_repair(self) -> None:
        words = enforce_aligned_word_limits(
            [TimedWord("店舗機器の近くで判断するエッジ", 1.0, 2.0, 0.8)],
            "ja",
        )
        self.assertEqual("".join(word.text for word in words), "店舗機器の近くで判断するエッジ")
        self.assertTrue(all(len(word.text) <= 14 for word in words))

    def test_retry_replacement_uses_word_indexes_when_text_repeats(self) -> None:
        original_words = [
            TimedWord("市場", 0.0, 0.4, 0.9),
            TimedWord("と", 0.4, 0.5, 0.9),
            TimedWord("市場", 0.5, 0.9, 0.4),
        ]
        corrected = apply_retry_decisions_to_punctuated_text(
            "市場と市場。",
            original_words,
            [
                {
                    "startIndex": 2,
                    "endIndex": 2,
                    "originalText": "市場",
                    "correctedText": "市況",
                    "applied": True,
                }
            ],
            language="ja",
        )
        self.assertEqual(corrected, "市場と市況。")

    def test_retry_fallback_preserves_candidate_word_boundaries(self) -> None:
        retry_log = [
            {
                "startIndex": 1,
                "endIndex": 2,
                "correctedText": "推論チップ",
                "applied": True,
                "selectedWords": [
                    {
                        "text": "推論",
                        "start": 0.4,
                        "end": 0.8,
                        "probability": 0.81,
                        "boundaryAfter": None,
                    },
                    {
                        "text": "チップ",
                        "start": 0.8,
                        "end": 1.2,
                        "probability": 0.84,
                        "boundaryAfter": None,
                    },
                ],
            }
        ]
        corrected, applied_count = replace_retry_spans_with_timed_candidates(
            [
                TimedWord("現場", 0.0, 0.4, 0.9),
                TimedWord("振り", 0.4, 0.8, 0.4),
                TimedWord("込み", 0.8, 1.2, 0.4, "medium"),
                TimedWord("です", 1.2, 1.5, 0.9),
            ],
            retry_log,
            language="ja",
        )
        self.assertEqual(applied_count, 1)
        self.assertEqual([word.text for word in corrected], ["現場", "推論", "チップ", "です"])
        self.assertEqual(corrected[2].boundary_after, "medium")

    def test_retry_fallback_discards_missing_timed_candidate(self) -> None:
        retry_log = [
            {
                "startIndex": 0,
                "endIndex": 0,
                "correctedText": "異常に長い候補",
                "applied": True,
                "selectedWords": [],
            }
        ]
        original = [TimedWord("原文", 0.0, 0.5, 0.4)]
        corrected, applied_count = replace_retry_spans_with_timed_candidates(
            original, retry_log, language="ja"
        )
        self.assertEqual(corrected, original)
        self.assertEqual(applied_count, 0)
        self.assertFalse(retry_log[0]["applied"])

    def test_precise_worker_failure_emits_one_error_frame(self) -> None:
        output = StringIO()
        with patch("koubox_runtime.precise_srt_worker.torch.cuda.is_available", return_value=False):
            with redirect_stdout(output):
                run(
                    "missing-model",
                    "missing-audio.wav",
                    mode="asr-only",
                    source_text=None,
                    language="ja",
                    speech_rate_mode="off",
                    ffmpeg_executable="missing-ffmpeg.exe",
                )
        messages = [line for line in output.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(messages), 1)
        self.assertIn('"type": "error"', messages[0])


if __name__ == "__main__":
    unittest.main()
