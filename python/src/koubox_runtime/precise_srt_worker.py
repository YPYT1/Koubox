from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Sequence

import torch

from .log import write as log_write
from .precise_srt import (
    _align_text,
    _extract_words,
    enforce_aligned_word_limits,
    _join_words,
    _low_confidence_ratio,
    _normalize_for_equality,
    _punctuated_text,
    _punctuated_text_from_words,
    _refine_oversized_aligned_words,
    _resolve_detected_language,
    _transcribe_original,
    _validate_final_segments,
    apply_builtin_terminology,
    apply_builtin_terminology_to_words,
    assess_speech_rate,
    mean_word_probability,
    normalize_language,
    repair_zero_duration_segments,
    repair_zero_duration_words,
    validate_request,
)
from .precise_srt_retry import (
    _detect_pauses,
    _retry_low_confidence_spans,
    _transcribe_full_speed_candidates,
    apply_retry_decisions_to_punctuated_text,
    choose_full_speed_candidate,
    replace_retry_spans_with_timed_candidates,
)
from .precise_srt_segmentation import segment_words
from .protocol import fail, send


_MODEL_CACHE: dict[tuple[str, str, str], object] = {}


def _load_model(model_directory: str, compute_type: str = "float16"):
    import stable_whisper

    key = (str(Path(model_directory).resolve()), "cuda", compute_type)
    cached = _MODEL_CACHE.get(key)
    if cached is None:
        cached = stable_whisper.load_faster_whisper(
            model_directory,
            device="cuda",
            compute_type=compute_type,
        )
        _MODEL_CACHE[key] = cached
    return cached


def _segments_from_aligned_result(
    result,
    *,
    model,
    audio_path: str,
    language: str,
    pauses: Sequence[tuple[float, float]],
) -> list[dict[str, float | str]]:
    words = _extract_words(result, language)
    if not words:
        raise ValueError("声学对齐没有返回词级时间戳。")
    words = _refine_oversized_aligned_words(model, audio_path, words, language)
    words = enforce_aligned_word_limits(repair_zero_duration_words(words), language)
    return repair_zero_duration_segments(
        segment_words(words, language=language, pauses=pauses)
    )


def run(
    model_directory: str,
    audio_path: str,
    *,
    mode: str,
    source_text: str | None,
    language: str,
    speech_rate_mode: str,
    ffmpeg_executable: str,
    compute_type: str = "float16",
) -> None:
    try:
        validate_request(
            mode=mode,
            language=language,
            speech_rate_mode=speech_rate_mode,
            source_text=source_text,
        )
        if not torch.cuda.is_available():
            raise RuntimeError("当前没有可用的 NVIDIA GPU，无法执行精准 SRT。")
        if not Path(model_directory).is_dir() or not Path(audio_path).is_file():
            raise FileNotFoundError("ASR 模型目录或音频文件不存在。")
        if not Path(ffmpeg_executable).is_file():
            raise FileNotFoundError(f"FFmpeg 不存在：{ffmpeg_executable}")

        import stable_whisper

        send("progress", stage="asr", percent=5, message="正在加载精准 SRT 模型")
        started_at = time.perf_counter()
        model = _load_model(model_directory, compute_type)
        requested_language = normalize_language(language)
        pauses, audio_duration_s, voiced_duration_s = _detect_pauses(audio_path)
        diagnostics: dict[str, object] = {
            "speechRateMode": speech_rate_mode,
            "speechRateTriggered": False,
            "multirateSpanCount": 0,
            "correctionCount": 0,
            "unresolvedLowConfidenceCount": 0,
            "audioDurationS": round(audio_duration_s, 4),
            "voicedDurationS": round(voiced_duration_s, 4),
            "pauseCount": len(pauses),
        }

        if mode == "align":
            if requested_language == "auto":
                send("progress", stage="asr", percent=18, message="正在检测音频语言")
                detection = _transcribe_original(model, audio_path, requested_language)
                detected_language = _resolve_detected_language(
                    detection, requested_language
                )
            else:
                detected_language = requested_language
            send(
                "progress",
                stage="align",
                percent=48,
                message="正在按用户文案进行声学对齐",
            )
            aligned = _align_text(
                model,
                audio_path,
                (source_text or "").strip(),
                detected_language,
            )
            send(
                "progress",
                stage="segment",
                percent=82,
                message="正在按气口和完整词语分段",
            )
            try:
                segments = _segments_from_aligned_result(
                    aligned,
                    model=model,
                    audio_path=audio_path,
                    language=detected_language,
                    pauses=pauses,
                )
            except ValueError as alignment_error:
                if detected_language != "ja":
                    raise
                log_write(
                    "warn",
                    "precise_srt",
                    "模式 A 常规对齐无法安全分段，使用 Janome 边界重新声学对齐",
                    {"error": str(alignment_error)},
                )
                diagnostics["alignmentFallback"] = "janome-tokenized-realign"
                aligned = _align_text(
                    model,
                    audio_path,
                    (source_text or "").strip(),
                    detected_language,
                    tokenize_japanese=True,
                )
                segments = _segments_from_aligned_result(
                    aligned,
                    model=model,
                    audio_path=audio_path,
                    language=detected_language,
                    pauses=pauses,
                )
            expected = _normalize_for_equality(source_text or "", detected_language)
            actual = _normalize_for_equality(
                "".join(str(item["text"]) for item in segments),
                detected_language,
            )
            if actual != expected:
                raise ValueError("模式 A 对齐结果未完整保留用户文案。")
        else:
            send("progress", stage="asr", percent=18, message="正在识别原始音频")
            initial = _transcribe_original(
                model,
                audio_path,
                requested_language,
                audio_duration_s=audio_duration_s,
            )
            detected_language = _resolve_detected_language(initial, requested_language)
            initial_words = _extract_words(initial, detected_language)
            if not initial_words:
                raise ValueError("语音识别没有返回词级时间戳。")
            log_write(
                "info",
                "precise_srt",
                "初次识别词级诊断",
                [
                    {
                        "index": index,
                        "text": word.text,
                        "start": round(word.start, 4),
                        "end": round(word.end, 4),
                        "probability": (
                            round(word.probability, 6)
                            if word.probability is not None
                            else None
                        ),
                    }
                    for index, word in enumerate(initial_words)
                ],
            )
            mean_probability = mean_word_probability(initial_words)
            low_ratio = _low_confidence_ratio(initial_words)
            assessment = assess_speech_rate(
                _join_words(initial_words, detected_language),
                language=detected_language,
                voiced_duration_s=voiced_duration_s,
                mean_probability=mean_probability,
                low_confidence_ratio=low_ratio,
            )
            diagnostics.update(
                {
                    "speechRateUnits": assessment.units,
                    "speechRateUnitsPerSecond": round(
                        assessment.units_per_second, 4
                    ),
                    "speechRateThreshold": assessment.threshold,
                    "meanWordProbability": round(mean_probability, 6),
                    "lowConfidenceRatio": round(low_ratio, 6),
                }
            )
            should_retry = speech_rate_mode == "force" or (
                speech_rate_mode == "auto" and assessment.should_retry
            )
            retry_words = initial_words
            retry_source_words = initial_words
            retry_punctuated = _punctuated_text(initial, detected_language)
            retry_log: list[dict[str, object]] = []
            if should_retry:
                diagnostics["speechRateTriggered"] = True
                send(
                    "progress",
                    stage="retry-asr",
                    percent=44,
                    message="正在对快速低置信度片段进行多速率复识别",
                )
                with tempfile.TemporaryDirectory(
                    prefix="koubox-srt-full-rate-"
                ) as full_rate_directory:
                    full_speed_candidates = _transcribe_full_speed_candidates(
                        model,
                        audio_path=audio_path,
                        ffmpeg_executable=ffmpeg_executable,
                        language=detected_language,
                        audio_duration_s=audio_duration_s,
                        target_directory=Path(full_rate_directory),
                    )
                    full_speed_choice = choose_full_speed_candidate(
                        units_per_second=assessment.units_per_second,
                        threshold=assessment.threshold,
                        original_words=initial_words,
                        candidates=full_speed_candidates,
                        language=detected_language,
                    )
                    if full_speed_choice:
                        selected_source, normalized_candidate = full_speed_choice
                        retry_words = normalized_candidate
                        retry_source_words = normalized_candidate
                        retry_punctuated = _punctuated_text_from_words(
                            normalized_candidate, detected_language
                        )
                        diagnostics["fullSpeedSelected"] = selected_source.removeprefix(
                            "full-"
                        )
                        diagnostics["fullSpeedMeanWordProbability"] = round(
                            mean_word_probability(normalized_candidate), 6
                        )
                        diagnostics["fullSpeedLowConfidenceRatio"] = round(
                            _low_confidence_ratio(normalized_candidate), 6
                        )
                    else:
                        retry_words, retry_log = _retry_low_confidence_spans(
                            model,
                            audio_path=audio_path,
                            ffmpeg_executable=ffmpeg_executable,
                            words=initial_words,
                            language=detected_language,
                            maximum_spans=12 if speech_rate_mode == "force" else 6,
                            threshold=(
                                0.60
                                if assessment.units_per_second
                                >= assessment.threshold * 1.30
                                else 0.55
                            ),
                            full_speed_candidates=full_speed_candidates,
                        )
                if retry_log:
                    log_write("info", "precise_srt", "多速率候选审计", retry_log)
            diagnostics["multirateSpanCount"] = len(retry_log)
            diagnostics["unresolvedLowConfidenceCount"] = sum(
                1 for item in retry_log if not bool(item["applied"])
            )

            punctuated = apply_retry_decisions_to_punctuated_text(
                retry_punctuated,
                retry_source_words,
                retry_log,
                language=detected_language,
            )
            corrected_punctuated, terminology_changes = apply_builtin_terminology(
                punctuated, detected_language
            )
            if terminology_changes:
                log_write(
                    "info",
                    "precise_srt",
                    "内置术语纠正审计",
                    terminology_changes,
                )
            corrected_plain, _ = apply_builtin_terminology(
                _join_words(retry_words, detected_language), detected_language
            )
            corrected_timed_words = apply_builtin_terminology_to_words(
                retry_words, detected_language
            )
            # 以最终带时间的词序列重新生成标点文本，避免文本规则只改了
            # 展示串而没有同步到词级序列，进而触发不必要的整任务失败。
            corrected_punctuated = _punctuated_text_from_words(
                corrected_timed_words, detected_language
            )
            if _normalize_for_equality(
                corrected_punctuated, detected_language
            ) != _normalize_for_equality(corrected_plain, detected_language):
                raise ValueError(
                    "纠正后的标点文本与词序列不一致。"
                    f" punctuated={_normalize_for_equality(corrected_punctuated, detected_language)!r}"
                    f" plain={_normalize_for_equality(corrected_plain, detected_language)!r}"
                )
            diagnostics["correctionCount"] = sum(
                1 for item in retry_log if bool(item["applied"])
            ) + len(terminology_changes)
            send(
                "progress",
                stage="align",
                percent=68,
                message="正在把纠正文本重新对齐原始音频",
            )
            send(
                "progress",
                stage="segment",
                percent=84,
                message="正在按气口和完整词语分段",
            )
            aligned = None
            alignment_error: Exception | None = None
            try:
                aligned = _align_text(
                    model,
                    audio_path,
                    corrected_punctuated,
                    detected_language,
                )
            except Exception as error:
                alignment_error = error
            try:
                if aligned is None:
                    raise ValueError(str(alignment_error or "重新对齐没有返回结果。"))
                segments = _segments_from_aligned_result(
                    aligned,
                    model=model,
                    audio_path=audio_path,
                    language=detected_language,
                    pauses=pauses,
                )
            except ValueError as alignment_error:
                log_write(
                    "warn",
                    "precise_srt",
                    "纠正文本重新对齐结果不可安全分段，回退到原音频 ASR 词时间",
                    {"error": str(alignment_error)},
                )
                diagnostics["alignmentFallback"] = "original-asr-word-timestamps"
                diagnostics["discardedMultirateCount"] = sum(
                    1 for item in retry_log if bool(item["applied"])
                )
                _, fallback_terminology_changes = apply_builtin_terminology(
                    _punctuated_text(initial, detected_language),
                    detected_language,
                )
                fallback_retry_words, fallback_applied_count = (
                    replace_retry_spans_with_timed_candidates(
                        initial_words,
                        retry_log,
                        language=detected_language,
                    )
                )
                fallback_words = apply_builtin_terminology_to_words(
                    fallback_retry_words, detected_language
                )
                diagnostics["discardedMultirateCount"] = max(
                    0,
                    int(diagnostics["discardedMultirateCount"])
                    - fallback_applied_count,
                )
                diagnostics["correctionCount"] = (
                    fallback_applied_count + len(fallback_terminology_changes)
                )
                segments = repair_zero_duration_segments(
                    segment_words(
                        fallback_words,
                        language=detected_language,
                        pauses=pauses,
                    )
                )

        _validate_final_segments(segments, language=detected_language)
        diagnostics["wallTimeS"] = round(time.perf_counter() - started_at, 3)
        log_write("info", "precise_srt", "精准 SRT 完成", diagnostics)
        send(
            "progress",
            stage="export-srt",
            percent=95,
            message="正在整理最终 SRT",
        )
        send(
            "transcript",
            language=detected_language,
            segments=segments,
            diagnostics=diagnostics,
        )
    except Exception as error:
        log_write("error", "precise_srt", str(error))
        fail("PRECISE_SRT_FAILED", str(error))
        return
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
