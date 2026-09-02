from __future__ import annotations

import math
import re
from typing import Sequence

from .precise_srt import (
    BUILTIN_TERMINOLOGY,
    CHINESE_ATTACH_TO_PREVIOUS,
    DISPLAY_LIMITS,
    ENGLISH_FUNCTION_WORDS,
    PhraseUnit,
    TimedWord,
    classify_pause,
    format_display_text,
    normalize_candidate_text,
    normalize_language,
    repair_zero_duration_words,
)


def _japanese_phrase_units(words: Sequence[TimedWord]) -> list[PhraseUnit]:
    try:
        from janome.tokenizer import Tokenizer
    except ImportError as error:
        raise RuntimeError("精准 SRT 日文分段需要 Janome。") from error

    text = "".join(word.text for word in words)
    tokenizer = Tokenizer()
    phrase_ends: set[int] = set()
    cursor = 0
    pending_end = 0
    for token in tokenizer.tokenize(text):
        surface = token.surface
        if not surface or not text.startswith(surface, cursor):
            raise ValueError(f"Janome 无法映射识别文本：{surface!r}")
        cursor += len(surface)
        pos = str(token.part_of_speech).split(",")
        head = pos[0] if pos else ""
        detail = pos[1] if len(pos) > 1 else ""
        if head in {"助詞", "助動詞"} or (head == "動詞" and detail == "接尾"):
            pending_end = cursor
            continue
        if pending_end:
            phrase_ends.add(pending_end)
            pending_end = 0
        phrase_ends.add(cursor)
    phrase_ends.add(len(text))

    word_ends: list[int] = []
    cursor = 0
    for word in words:
        cursor += len(word.text)
        word_ends.append(cursor)
    valid_ends = phrase_ends.intersection(word_ends)
    valid_ends.add(len(text))

    units: list[PhraseUnit] = []
    chunk: list[TimedWord] = []
    for word, word_end in zip(words, word_ends, strict=True):
        chunk.append(word)
        if word_end in valid_ends:
            units.append(PhraseUnit(tuple(chunk)))
            chunk = []
    if chunk:
        units.append(PhraseUnit(tuple(chunk)))
    return _merge_japanese_suffix_units(units)


def _merge_japanese_suffix_units(units: Sequence[PhraseUnit]) -> list[PhraseUnit]:
    merged: list[PhraseUnit] = []
    for unit in units:
        if merged and unit.text in {"です", "ます", "でした", "ません", "では"}:
            merged[-1] = PhraseUnit((*merged[-1].words, *unit.words))
        else:
            merged.append(unit)
    return merged


def _language_phrase_units(
    words: Sequence[TimedWord], language: str
) -> list[PhraseUnit]:
    if language == "ja":
        return _japanese_phrase_units(words)
    units: list[PhraseUnit] = []
    for word in words:
        clean = format_display_text(word.text)
        if not clean:
            continue
        normalized = TimedWord(
            clean,
            word.start,
            word.end,
            word.probability,
            word.boundary_after,
        )
        if language == "zh" and units and clean in CHINESE_ATTACH_TO_PREVIOUS:
            units[-1] = PhraseUnit((*units[-1].words, normalized))
        else:
            units.append(PhraseUnit((normalized,)))
    return units


def _unit_text(unit: PhraseUnit, language: str) -> str:
    separator = " " if language in {"en", "ko"} else ""
    return separator.join(word.text for word in unit.words)


def _join_units(units: Sequence[PhraseUnit], language: str) -> str:
    separator = " " if language in {"en", "ko"} else ""
    return separator.join(_unit_text(unit, language) for unit in units)


def _merge_terminology_units(
    units: Sequence[PhraseUnit], language: str
) -> list[PhraseUnit]:
    targets = {
        normalize_candidate_text(rule.target)
        for rule in BUILTIN_TERMINOLOGY[language]
        if normalize_candidate_text(rule.target)
    }
    if not targets:
        return list(units)
    merged: list[PhraseUnit] = []
    index = 0
    while index < len(units):
        matched_end = index + 1
        for end in range(min(len(units), index + 8), index, -1):
            text = _join_units(units[index:end], language)
            if normalize_candidate_text(text) in targets:
                matched_end = end
                break
        if matched_end > index + 1:
            merged.append(
                PhraseUnit(
                    tuple(
                        word
                        for unit in units[index:matched_end]
                        for word in unit.words
                    )
                )
            )
        else:
            merged.append(units[index])
        index = matched_end
    return merged


def _unit_fits(
    unit: PhraseUnit,
    *,
    language: str,
    limits: dict[str, int | None],
    max_duration_s: float,
) -> bool:
    text = _unit_text(unit, language)
    chars = len(re.sub(r"\s+", "", text))
    max_words = limits["max_words"]
    return (
        unit.end - unit.start <= max_duration_s
        and chars <= int(limits["max_chars"] or 0)
        and (max_words is None or len(unit.words) <= int(max_words))
    )


def _split_oversized_units(
    units: Sequence[PhraseUnit],
    *,
    language: str,
    limits: dict[str, int | None],
    max_duration_s: float,
) -> list[PhraseUnit]:
    result: list[PhraseUnit] = []
    for unit in units:
        if _unit_fits(
            unit,
            language=language,
            limits=limits,
            max_duration_s=max_duration_s,
        ):
            result.append(unit)
            continue
        if len(unit.words) == 1:
            raise ValueError(
                f"单个已对齐词超过{language}字幕硬限制，不能在词内拆分：{unit.words[0].text}"
            )
        chunk: list[TimedWord] = []
        for word in unit.words:
            candidate = PhraseUnit(tuple([*chunk, word]))
            if chunk and not _unit_fits(
                candidate,
                language=language,
                limits=limits,
                max_duration_s=max_duration_s,
            ):
                result.append(PhraseUnit(tuple(chunk)))
                chunk = [word]
            else:
                chunk.append(word)
            if not _unit_fits(
                PhraseUnit(tuple(chunk)),
                language=language,
                limits=limits,
                max_duration_s=max_duration_s,
            ):
                raise ValueError(
                    f"单个已对齐词超过{language}字幕硬限制，不能在词内拆分：{word.text}"
                )
        if chunk:
            result.append(PhraseUnit(tuple(chunk)))
    return result


def _pause_tier_between(
    left: PhraseUnit,
    right: PhraseUnit,
    pauses: Sequence[tuple[float, float]],
) -> str | None:
    actual_gap_start = left.end
    actual_gap_end = right.start
    if actual_gap_end - actual_gap_start < 0.12:
        return None
    overlap_durations = [
        max(0.0, min(end, actual_gap_end) - max(start, actual_gap_start))
        for start, end in pauses
    ]
    if not overlap_durations:
        return None
    return classify_pause(max(overlap_durations))


def _span_word_count(units: Sequence[PhraseUnit]) -> int:
    return sum(len(re.findall(r"\S+", unit.text)) for unit in units)


def segment_words(
    words: Sequence[TimedWord],
    *,
    language: str,
    pauses: Sequence[tuple[float, float]],
    max_duration_s: float = 3.0,
) -> list[dict[str, float | str]]:
    normalized_language = normalize_language(language)
    if normalized_language == "auto":
        raise ValueError("分段前必须确定语言。")
    if not words:
        return []
    repaired_words = repair_zero_duration_words(words)
    units = _language_phrase_units(repaired_words, normalized_language)
    if not units:
        return []
    limits = DISPLAY_LIMITS[normalized_language]
    units = _merge_terminology_units(units, normalized_language)
    units = _split_oversized_units(
        units,
        language=normalized_language,
        limits=limits,
        max_duration_s=max_duration_s,
    )
    count = len(units)
    cost = [math.inf] * (count + 1)
    previous = [-1] * (count + 1)
    cost[0] = 0.0

    for end_exclusive in range(1, count + 1):
        for start in range(end_exclusive - 1, -1, -1):
            selected = units[start:end_exclusive]
            text = _join_units(selected, normalized_language)
            duration = selected[-1].end - selected[0].start
            chars = len(re.sub(r"\s+", "", text))
            word_count = _span_word_count(selected)
            if duration > max_duration_s or chars > int(limits["max_chars"]):
                continue
            max_words = limits["max_words"]
            if max_words is not None and word_count > int(max_words):
                continue

            candidate = cost[start] + abs(chars - int(limits["target_chars"])) * 0.12
            candidate += abs(duration - 1.4) * 0.25
            if start > 0:
                tier = _pause_tier_between(units[start - 1], units[start], pauses)
                pause_bonus = {"hard": -4.0, "medium": -2.5, "soft": -0.8}.get(
                    tier, 0.7
                )
                punctuation_tier = units[start - 1].words[-1].boundary_after
                punctuation_bonus = {"hard": -4.0, "medium": -2.5}.get(
                    punctuation_tier, 0.7
                )
                candidate += min(pause_bonus, punctuation_bonus)
                if (
                    normalized_language == "en"
                    and units[start].text.lower() in ENGLISH_FUNCTION_WORDS
                ):
                    candidate += 3.0
            if candidate < cost[end_exclusive]:
                cost[end_exclusive] = candidate
                previous[end_exclusive] = start

    if previous[count] < 0:
        raise ValueError("字幕原子单元超过语言展示硬限制，无法安全分段。")

    spans: list[tuple[int, int]] = []
    cursor = count
    while cursor > 0:
        start = previous[cursor]
        if start < 0:
            raise ValueError("字幕动态规划回溯失败。")
        spans.append((start, cursor))
        cursor = start
    spans.reverse()

    return [
        {
            "text": _join_units(units[start:end], normalized_language),
            "start": units[start].start,
            "end": units[end - 1].end,
        }
        for start, end in spans
    ]
