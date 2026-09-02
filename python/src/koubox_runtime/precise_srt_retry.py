from __future__ import annotations

import math
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence

import numpy as np
import soundfile as sf

from .precise_srt import (
    BUILTIN_PROMPTS,
    DISPLAY_LIMITS,
    LowConfidenceSpan,
    TimedWord,
    _extract_words,
    _join_words,
    choose_multirate_candidate,
    mean_word_probability,
    normalize_candidate_text,
)


def choose_full_speed_candidate(
    *,
    units_per_second: float,
    threshold: float,
    original_words: Sequence[TimedWord],
    candidates: dict[str, list[TimedWord]],
    language: str,
) -> tuple[str, list[TimedWord]] | None:
    if units_per_second < threshold * 2.0 or len(candidates) < 2:
        return None
    decision = choose_multirate_candidate(
        original_text=_join_words(original_words, language),
        original_probability=mean_word_probability(original_words),
        candidates=[
            (
                _join_words(words, language),
                mean_word_probability(words),
                source,
            )
            for source, words in candidates.items()
            if words
        ],
    )
    if not decision.applied:
        return None
    for source in decision.agreeing_sources:
        selected = candidates.get(source)
        if selected:
            return source, selected
    return None


def find_suspicious_spans(
    words: Sequence[TimedWord],
    *,
    threshold: float = 0.55,
    maximum_spans: int = 6,
    language: str = "ja",
) -> list[LowConfidenceSpan]:
    low_indexes = [
        index
        for index, word in enumerate(words)
        if word.probability is not None and word.probability < threshold
    ]
    if not low_indexes:
        return []

    clusters: list[tuple[int, int]] = []
    first = previous = low_indexes[0]
    for index in low_indexes[1:]:
        if words[index].start - words[previous].end <= 0.40:
            previous = index
            continue
        clusters.append((first, previous))
        first = previous = index
    clusters.append((first, previous))

    expanded: list[tuple[int, int, int, int]] = []
    for low_start, low_end in clusters:
        start = low_start
        for _ in range(4):
            if start == 0 or words[start - 1].boundary_after:
                break
            start -= 1
        end = low_end
        for _ in range(4):
            if end >= len(words) - 1 or words[end].boundary_after:
                break
            end += 1
            if words[end].boundary_after:
                break
        while (
            end > start
            and (
                len(
                    normalize_candidate_text(
                        _join_words(words[start : end + 1], language)
                    )
                )
                > 18
                or words[end].end - words[start].start > 2.5
            )
        ):
            if start < low_start and (low_start - start) >= (end - low_end):
                start += 1
            elif end > low_end:
                end -= 1
            else:
                break
        expanded.append((start, end, low_start, low_end))

    merged: list[tuple[int, int, list[int]]] = []
    for start, end, low_start, low_end in expanded:
        low_range = list(range(low_start, low_end + 1))
        if merged and start <= merged[-1][1] + 1:
            previous_start, previous_end, previous_lows = merged[-1]
            merged[-1] = (
                previous_start,
                max(previous_end, end),
                [*previous_lows, *low_range],
            )
        else:
            merged.append((start, end, low_range))

    spans: list[LowConfidenceSpan] = []
    for start, end, low_range in merged[:maximum_spans]:
        selected = words[start : end + 1]
        probabilities = [
            words[index].probability
            for index in low_range
            if words[index].probability is not None
            and words[index].probability < threshold
        ]
        spans.append(
            LowConfidenceSpan(
                start_index=start,
                end_index=end,
                start=selected[0].start,
                end=selected[-1].end,
                text=_join_words(selected, language),
                probability=(
                    sum(float(value) for value in probabilities) / len(probabilities)
                    if probabilities
                    else mean_word_probability(selected)
                ),
            )
        )
    return spans


def select_timed_candidate(
    words: Sequence[TimedWord],
    *,
    crop_start: float,
    span_start: float,
    span_end: float,
    speed: float,
    language: str,
) -> tuple[str, float] | None:
    target_start = (span_start - crop_start) / speed
    target_end = (span_end - crop_start) / speed
    padding = 0.02
    selected = [
        word
        for word in words
        if target_start - padding
        <= (word.start + word.end) / 2
        <= target_end + padding
    ]
    if not selected:
        return None
    text = _join_words(selected, language)
    return (text, mean_word_probability(selected)) if text else None


def _detect_pauses(
    audio_path: str,
    *,
    silence_db: float = -35.0,
    minimum_pause_s: float = 0.12,
    frame_s: float = 0.01,
) -> tuple[list[tuple[float, float]], float, float]:
    samples, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    frame_size = max(1, round(sample_rate * frame_s))
    frame_count = math.ceil(len(mono) / frame_size)
    padded = np.pad(mono, (0, frame_count * frame_size - len(mono)))
    frames = padded.reshape(frame_count, frame_size)
    rms = np.sqrt(np.mean(np.square(frames), axis=1)).clip(min=1e-8)
    db = 20 * np.log10(rms)
    # FLEURS 与用户上传音频可能存在整体录音增益差异。先以当前片段
    # 峰值归一化 VAD 的相对能量，再应用产品静音阈值；不改写送入 ASR
    # 的原始音频，只修正语速估计和气口检测。
    peak_db = float(np.max(db))
    relative_db = db - peak_db
    quiet = (relative_db <= silence_db).tolist()
    pauses: list[tuple[float, float]] = []
    start_index: int | None = None
    for index, is_quiet in enumerate([*quiet, False]):
        if is_quiet and start_index is None:
            start_index = index
        elif not is_quiet and start_index is not None:
            start = start_index * frame_size / sample_rate
            end = min(index * frame_size / sample_rate, len(mono) / sample_rate)
            if end - start >= minimum_pause_s:
                pauses.append((round(start, 4), round(end, 4)))
            start_index = None
    duration = len(mono) / sample_rate
    silent_duration = sum(end - start for start, end in pauses)
    voiced_duration = max(0.01, duration - silent_duration)
    return pauses, duration, voiced_duration


def _run_ffmpeg(arguments: Sequence[str]) -> None:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    completed = subprocess.run(
        list(arguments),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"FFmpeg 语速处理失败：{message}")


def _write_speed_crops(
    ffmpeg_executable: str,
    audio_path: str,
    target_directory: Path,
    *,
    start: float,
    end: float,
    speeds: Sequence[float] = (1.0, 0.90, 0.80),
) -> dict[str, Path]:
    outputs: dict[str, Path] = {}
    for speed in speeds:
        label = f"{speed:.2f}"
        output = target_directory / f"crop-{label}.wav"
        command = [
            ffmpeg_executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.4f}",
            "-to",
            f"{end:.4f}",
            "-i",
            audio_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
        ]
        if speed != 1.0:
            command.extend(["-filter:a", f"atempo={speed:.2f}"])
        command.extend(["-c:a", "pcm_s16le", str(output)])
        _run_ffmpeg(command)
        outputs[label] = output
    return outputs


def map_speed_words_to_original_time(
    words: Sequence[TimedWord], speed: float
) -> list[TimedWord]:
    return [
        TimedWord(
            word.text,
            word.start * speed,
            word.end * speed,
            word.probability,
            word.boundary_after,
        )
        for word in words
    ]


def replace_retry_spans_with_timed_candidates(
    words: Sequence[TimedWord],
    retry_log: Sequence[dict[str, object]],
    *,
    language: str,
) -> tuple[list[TimedWord], int]:
    corrected = list(words)
    applied_count = 0
    for item in sorted(
        (entry for entry in retry_log if bool(entry.get("applied"))),
        key=lambda entry: int(entry["startIndex"]),
        reverse=True,
    ):
        start_index = int(item["startIndex"])
        end_index = int(item["endIndex"])
        raw_words = item.get("selectedWords")
        if (
            start_index < 0
            or end_index >= len(corrected)
            or end_index < start_index
            or not isinstance(raw_words, list)
            or not raw_words
        ):
            item["applied"] = False
            item["rejectionReason"] = "missing-valid-timed-candidate"
            continue
        selected_words = [
            TimedWord(
                str(word["text"]),
                float(word["start"]),
                float(word["end"]),
                (
                    float(word["probability"])
                    if word.get("probability") is not None
                    else None
                ),
                str(word["boundaryAfter"])
                if word.get("boundaryAfter")
                else None,
            )
            for word in raw_words
            if isinstance(word, dict) and str(word.get("text", "")).strip()
        ]
        if (
            not selected_words
            or normalize_candidate_text(_join_words(selected_words, language))
            != normalize_candidate_text(str(item["correctedText"]))
            or any(word.end <= word.start for word in selected_words)
            or any(
                len(normalize_candidate_text(word.text))
                > int(DISPLAY_LIMITS[language]["max_chars"])
                or word.end - word.start > 3.0
                for word in selected_words
            )
        ):
            item["applied"] = False
            item["rejectionReason"] = "invalid-timed-candidate"
            continue
        selected_words[-1] = TimedWord(
            selected_words[-1].text,
            selected_words[-1].start,
            selected_words[-1].end,
            selected_words[-1].probability,
            words[end_index].boundary_after or selected_words[-1].boundary_after,
        )
        corrected[start_index : end_index + 1] = selected_words
        applied_count += 1
    return corrected, applied_count


def _transcribe_full_speed_candidates(
    model,
    *,
    audio_path: str,
    ffmpeg_executable: str,
    language: str,
    audio_duration_s: float,
    target_directory: Path,
) -> dict[str, list[TimedWord]]:
    paths = _write_speed_crops(
        ffmpeg_executable,
        audio_path,
        target_directory,
        start=0.0,
        end=audio_duration_s,
        speeds=(0.90, 0.80),
    )
    results: dict[str, list[TimedWord]] = {}
    for source, path in paths.items():
        speed = float(source)
        result = model.transcribe(
            str(path),
            language=language,
            regroup=False,
            beam_size=5,
            condition_on_previous_text=audio_duration_s / speed <= 60.0,
            temperature=0.0,
            vad_filter=False,
            chunk_length=30,
            initial_prompt=BUILTIN_PROMPTS.get(language) or None,
            verbose=None,
        )
        results[f"full-{source}"] = map_speed_words_to_original_time(
            _extract_words(result, language), speed
        )
    return results


def _retry_low_confidence_spans(
    model,
    *,
    audio_path: str,
    ffmpeg_executable: str,
    words: Sequence[TimedWord],
    language: str,
    maximum_spans: int,
    threshold: float = 0.55,
    full_speed_candidates: dict[str, list[TimedWord]] | None = None,
) -> tuple[list[TimedWord], list[dict[str, object]]]:
    spans = find_suspicious_spans(
        words,
        threshold=threshold,
        maximum_spans=maximum_spans,
        language=language,
    )
    corrected_words = list(words)
    retry_log: list[dict[str, object]] = []
    for span in reversed(spans):
        before_words = words[max(0, span.start_index - 2) : span.start_index]
        after_words = words[span.end_index + 1 : span.end_index + 3]
        before_text = _join_words(before_words, language)
        after_text = _join_words(after_words, language)
        crop_start = max(0.0, span.start - 0.6)
        crop_end = span.end + 0.6
        candidates: list[tuple[str, float, str]] = []
        timed_candidates: dict[str, list[TimedWord]] = {}
        for source, candidate_words in (full_speed_candidates or {}).items():
            candidate = select_timed_candidate(
                candidate_words,
                crop_start=0.0,
                span_start=span.start,
                span_end=span.end,
                speed=1.0,
                language=language,
            )
            if candidate:
                candidate_text, candidate_probability = candidate
                candidates.append((candidate_text, candidate_probability, source))
                timed_candidates[source] = [
                    word
                    for word in candidate_words
                    if span.start - 0.02
                    <= (word.start + word.end) / 2
                    <= span.end + 0.02
                ]
        with tempfile.TemporaryDirectory(prefix="koubox-srt-rate-") as temporary:
            crops = _write_speed_crops(
                ffmpeg_executable,
                audio_path,
                Path(temporary),
                start=crop_start,
                end=crop_end,
            )
            for source, crop_path in crops.items():
                local_result = model.transcribe(
                    str(crop_path),
                    language=language,
                    regroup=False,
                    beam_size=5,
                    condition_on_previous_text=False,
                    temperature=0.0,
                    vad_filter=False,
                    chunk_length=30,
                    initial_prompt=(f"{before_text} {after_text}".strip() or None),
                    verbose=None,
                )
                local_words = _extract_words(local_result, language)
                candidate = select_timed_candidate(
                    local_words,
                    crop_start=crop_start,
                    span_start=span.start,
                    span_end=span.end,
                    speed=float(source),
                    language=language,
                )
                if candidate:
                    candidate_text, candidate_probability = candidate
                    candidates.append((candidate_text, candidate_probability, source))
                    target_start = (span.start - crop_start) / float(source)
                    target_end = (span.end - crop_start) / float(source)
                    selected_local_words = [
                        word
                        for word in local_words
                        if target_start - 0.02
                        <= (word.start + word.end) / 2
                        <= target_end + 0.02
                    ]
                    timed_candidates[source] = [
                        TimedWord(
                            word.text,
                            max(span.start, crop_start + word.start * float(source)),
                            min(span.end, crop_start + word.end * float(source)),
                            word.probability,
                            word.boundary_after,
                        )
                        for word in selected_local_words
                    ]
        decision = choose_multirate_candidate(
            original_text=span.text,
            original_probability=span.probability,
            candidates=candidates,
        )
        selected_words: list[TimedWord] = []
        if decision.applied:
            for source in decision.agreeing_sources:
                candidate_words = timed_candidates.get(source) or []
                if (
                    candidate_words
                    and normalize_candidate_text(_join_words(candidate_words, language))
                    == normalize_candidate_text(decision.text)
                ):
                    selected_words = candidate_words
                    break
        retry_log.append(
            {
                "start": round(span.start, 4),
                "end": round(span.end, 4),
                "startIndex": span.start_index,
                "endIndex": span.end_index,
                "originalText": span.text,
                "originalProbability": round(span.probability, 6),
                "correctedText": decision.text,
                "selectedProbability": round(decision.probability, 6),
                "applied": decision.applied,
                "agreeingSources": list(decision.agreeing_sources),
                "selectedWords": [
                    {
                        "text": word.text,
                        "start": round(word.start, 4),
                        "end": round(word.end, 4),
                        "probability": word.probability,
                        "boundaryAfter": word.boundary_after,
                    }
                    for word in selected_words
                ],
                "candidates": [
                    {"text": text, "probability": probability, "source": source}
                    for text, probability, source in candidates
                ],
            }
        )
    retry_log.reverse()
    corrected_words, _ = replace_retry_spans_with_timed_candidates(
        words, retry_log, language=language
    )
    return corrected_words, retry_log


def apply_retry_decisions_to_punctuated_text(
    punctuated_text: str,
    original_words: Sequence[TimedWord],
    retry_log: Sequence[dict[str, object]],
    *,
    language: str,
) -> str:
    spans: list[tuple[int, int]] = []
    cursor = 0
    haystack = punctuated_text.lower() if language == "en" else punctuated_text
    for word in original_words:
        needle = word.text.lower() if language == "en" else word.text
        index = haystack.find(needle, cursor)
        if index < 0:
            raise ValueError(f"识别词无法映射回带标点文本：{word.text}")
        spans.append((index, index + len(word.text)))
        cursor = index + len(word.text)

    corrected = punctuated_text
    applied = sorted(
        (item for item in retry_log if bool(item["applied"])),
        key=lambda item: int(item["startIndex"]),
        reverse=True,
    )
    for item in applied:
        start_index = int(item["startIndex"])
        end_index = int(item["endIndex"])
        if start_index < 0 or end_index >= len(spans) or end_index < start_index:
            raise ValueError("多速率纠正返回了无效词索引。")
        start = spans[start_index][0]
        end = spans[end_index][1]
        corrected = corrected[:start] + str(item["correctedText"]) + corrected[end:]
    return corrected
