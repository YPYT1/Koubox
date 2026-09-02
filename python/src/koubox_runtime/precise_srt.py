from __future__ import annotations

import re
import tempfile
import tomllib
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable, Sequence

import soundfile as sf



DISPLAY_STRIP_CHARS = frozenset(
    "・·･、，。！？：；「」『』\"（）()[]【】《》〈〉…—,.!?;:"
)
HARD_BOUNDARY_CHARS = frozenset("。！？!?")
MEDIUM_BOUNDARY_CHARS = frozenset("、，,・·･；;：:")

LANGUAGE_ALIASES = {
    "zh-hans": "zh",
    "zh-hant": "zh",
    "zh": "zh",
    "chinese": "zh",
    "en": "en",
    "english": "en",
    "ja": "ja",
    "japanese": "ja",
    "ko": "ko",
    "korean": "ko",
}

DISPLAY_LIMITS = {
    "zh": {"max_chars": 14, "max_words": None, "target_chars": 9},
    "ja": {"max_chars": 14, "max_words": None, "target_chars": 8},
    "en": {"max_chars": 42, "max_words": 8, "target_chars": 28},
    "ko": {"max_chars": 18, "max_words": None, "target_chars": 12},
}

ENGLISH_FUNCTION_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "as",
        "at",
        "but",
        "by",
        "for",
        "from",
        "in",
        "of",
        "on",
        "or",
        "the",
        "to",
        "with",
    }
)

CHINESE_ATTACH_TO_PREVIOUS = frozenset("的了着过吗呢吧啊呀")


@dataclass(frozen=True)
class TimedWord:
    text: str
    start: float
    end: float
    probability: float | None = None
    boundary_after: str | None = None


@dataclass(frozen=True)
class CandidateDecision:
    text: str
    probability: float
    applied: bool
    agreeing_sources: tuple[str, ...]


@dataclass(frozen=True)
class SpeechRateAssessment:
    language: str
    units: int
    voiced_duration_s: float
    units_per_second: float
    threshold: float
    mean_probability: float
    low_confidence_ratio: float
    should_retry: bool


@dataclass(frozen=True)
class PhraseUnit:
    words: tuple[TimedWord, ...]

    @property
    def text(self) -> str:
        return "".join(word.text for word in self.words)

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end


@dataclass(frozen=True)
class TerminologyRule:
    rule_id: str
    source: str
    target: str


@dataclass(frozen=True)
class LowConfidenceSpan:
    start_index: int
    end_index: int
    start: float
    end: float
    text: str
    probability: float


def _load_builtin_config() -> dict[str, object]:
    path = Path(__file__).with_name("precise_srt_terms.toml")
    return tomllib.loads(path.read_text(encoding="utf-8"))


BUILTIN_CONFIG = _load_builtin_config()


def _load_builtin_terminology() -> dict[str, tuple[TerminologyRule, ...]]:
    configured = BUILTIN_CONFIG.get("rules", {})
    result: dict[str, tuple[TerminologyRule, ...]] = {}
    for language in ("zh", "en", "ja", "ko"):
        result[language] = tuple(
            TerminologyRule(
                rule_id=str(item["id"]),
                source=str(item["source"]),
                target=str(item["target"]),
            )
            for item in configured.get(language, [])
        )
    return result


BUILTIN_TERMINOLOGY = _load_builtin_terminology()


def _load_builtin_prompts() -> dict[str, str]:
    configured = BUILTIN_CONFIG.get("prompts", {})
    return {
        language: str(configured.get(language, "")).strip()
        for language in ("zh", "en", "ja", "ko")
    }


BUILTIN_PROMPTS = _load_builtin_prompts()


def _load_fast_rate_thresholds() -> dict[str, float]:
    configured = BUILTIN_CONFIG.get("speech_rate_thresholds", {})
    thresholds = {
        language: float(configured.get(language, 0.0))
        for language in ("zh", "en", "ja", "ko")
    }
    invalid = [language for language, value in thresholds.items() if value <= 0]
    if invalid:
        raise ValueError(f"精准 SRT 语速阈值配置缺失或无效：{', '.join(invalid)}")
    return thresholds


FAST_RATE_THRESHOLDS = _load_fast_rate_thresholds()


def normalize_language(language: str) -> str:
    normalized = language.strip().lower().replace("_", "-")
    if normalized == "auto":
        return "auto"
    result = LANGUAGE_ALIASES.get(normalized)
    if result is None:
        raise ValueError(f"精准 SRT 仅支持中文、英文、日文、韩文：{language}")
    return result


def validate_request(
    *,
    mode: str,
    language: str,
    speech_rate_mode: str,
    source_text: str | None,
) -> None:
    if mode not in {"align", "asr-only"}:
        raise ValueError(f"未知精准 SRT 模式：{mode}")
    normalize_language(language)
    if speech_rate_mode not in {"off", "auto", "force"}:
        raise ValueError(f"未知语速策略：{speech_rate_mode}")
    if mode == "align" and not (source_text or "").strip():
        raise ValueError("有文案模式必须提供口播原文稿。")
    if mode == "asr-only" and (source_text or "").strip():
        raise ValueError("无文案模式不得接收参考文案。")


def format_display_text(text: str) -> str:
    return "".join(char for char in text if char not in DISPLAY_STRIP_CHARS).strip()


def _boundary_after(text: str) -> str | None:
    if any(char in HARD_BOUNDARY_CHARS for char in text):
        return "hard"
    if any(char in MEDIUM_BOUNDARY_CHARS for char in text):
        return "medium"
    return None


def normalize_candidate_text(text: str) -> str:
    return re.sub(r"\s+", "", format_display_text(text)).lower()


def classify_pause(duration_s: float) -> str | None:
    if duration_s >= 0.45:
        return "hard"
    if duration_s >= 0.22:
        return "medium"
    if duration_s >= 0.12:
        return "soft"
    return None


def choose_multirate_candidate(
    *,
    original_text: str,
    original_probability: float,
    candidates: Sequence[tuple[str, float, str]],
    minimum_gain: float = 0.10,
) -> CandidateDecision:
    grouped: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    for text, probability, source in candidates:
        normalized = normalize_candidate_text(text)
        if normalized:
            grouped[normalized].append((format_display_text(text), probability, source))

    eligible: list[tuple[float, str, tuple[str, ...]]] = []
    original_normalized = normalize_candidate_text(original_text)
    original_length = max(1, len(original_normalized))
    for normalized, agreeing in grouped.items():
        if normalized == original_normalized or len(agreeing) < 2:
            continue
        candidate_length = len(normalized)
        if (
            candidate_length > max(4, original_length * 2)
            or candidate_length * 2 < original_length
        ):
            continue
        mean_probability = sum(item[1] for item in agreeing) / len(agreeing)
        if mean_probability - original_probability < minimum_gain:
            continue
        eligible.append(
            (
                mean_probability,
                agreeing[0][0],
                tuple(item[2] for item in agreeing),
            )
        )

    if not eligible:
        return CandidateDecision(original_text, original_probability, False, ())
    probability, text, sources = max(
        eligible,
        key=lambda item: (item[0], len(item[2]), normalize_candidate_text(item[1])),
    )
    return CandidateDecision(text, probability, True, sources)


def apply_builtin_terminology(
    text: str, language: str
) -> tuple[str, list[dict[str, str | int]]]:
    normalized_language = normalize_language(language)
    if normalized_language == "auto":
        raise ValueError("应用术语规则前必须确定语言。")
    corrected = text
    changes: list[dict[str, str | int]] = []
    rules = sorted(
        BUILTIN_TERMINOLOGY[normalized_language],
        key=lambda rule: len(rule.source),
        reverse=True,
    )
    for rule in rules:
        search_from = 0
        while True:
            index = corrected.find(rule.source, search_from)
            if index < 0:
                break
            corrected = (
                corrected[:index]
                + rule.target
                + corrected[index + len(rule.source) :]
            )
            changes.append(
                {
                    "rule_id": rule.rule_id,
                    "source": rule.source,
                    "target": rule.target,
                    "offset": index,
                }
            )
            search_from = index + len(rule.target)
    return corrected, changes


def apply_builtin_terminology_to_words(
    words: Sequence[TimedWord], language: str
) -> list[TimedWord]:
    normalized_language = normalize_language(language)
    if normalized_language == "auto":
        raise ValueError("应用术语规则前必须确定语言。")
    if normalized_language not in {"zh", "ja"}:
        return list(words)
    corrected = list(words)
    rules = sorted(
        BUILTIN_TERMINOLOGY[normalized_language],
        key=lambda rule: len(rule.source),
        reverse=True,
    )
    for rule in rules:
        search_from = 0
        while True:
            full_text = "".join(word.text for word in corrected)
            offset = full_text.find(rule.source, search_from)
            if offset < 0:
                break
            end_offset = offset + len(rule.source)
            cursor = 0
            start_index = end_index = None
            for index, word in enumerate(corrected):
                next_cursor = cursor + len(word.text)
                if cursor == offset:
                    start_index = index
                if next_cursor == end_offset:
                    end_index = index
                    break
                cursor = next_cursor
            if start_index is None or end_index is None:
                search_from = offset + 1
                continue
            selected = corrected[start_index : end_index + 1]
            probabilities = [
                word.probability
                for word in selected
                if word.probability is not None
            ]
            corrected[start_index : end_index + 1] = [
                TimedWord(
                    rule.target,
                    selected[0].start,
                    selected[-1].end,
                    (
                        sum(float(value) for value in probabilities)
                        / len(probabilities)
                        if probabilities
                        else None
                    ),
                    selected[-1].boundary_after,
                )
            ]
            search_from = offset + len(rule.target)
    return corrected


def _speech_units(text: str, language: str) -> int:
    normalized = format_display_text(text)
    if language == "en":
        return len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", normalized))
    if language == "zh":
        return len(re.findall(r"[\u3400-\u9fff]", normalized))
    if language == "ko":
        return len(re.findall(r"[\uac00-\ud7a3]", normalized))
    return len(re.sub(r"\s+", "", normalized))


def assess_speech_rate(
    text: str,
    *,
    language: str,
    voiced_duration_s: float,
    mean_probability: float,
    low_confidence_ratio: float,
) -> SpeechRateAssessment:
    normalized_language = normalize_language(language)
    if normalized_language == "auto":
        raise ValueError("评估语速前必须确定语言。")
    if voiced_duration_s <= 0:
        raise ValueError("有效发声时长必须大于 0。")
    units = _speech_units(text, normalized_language)
    rate = units / voiced_duration_s
    threshold = FAST_RATE_THRESHOLDS[normalized_language]
    confidence_is_low = mean_probability < 0.92 or low_confidence_ratio >= 0.06
    extreme_rate_with_warning = rate >= threshold * 2.0 and (
        mean_probability < 0.95 or low_confidence_ratio >= 0.04
    )
    return SpeechRateAssessment(
        language=normalized_language,
        units=units,
        voiced_duration_s=voiced_duration_s,
        units_per_second=rate,
        threshold=threshold,
        mean_probability=mean_probability,
        low_confidence_ratio=low_confidence_ratio,
        should_retry=rate >= threshold
        and (confidence_is_low or extreme_rate_with_warning),
    )


def repair_zero_duration_segments(
    segments: Sequence[dict[str, float | str]],
    *,
    minimum_duration_s: float = 0.08,
) -> list[dict[str, float | str]]:
    del minimum_duration_s
    repaired: list[dict[str, float | str]] = []
    pending_text = ""
    for segment in segments:
        item = dict(segment)
        start = float(item["start"])
        end = float(item["end"])
        text = str(item["text"])
        if end - start <= 1e-6:
            if repaired and start <= float(repaired[-1]["end"]) + 1e-6:
                repaired[-1]["text"] = str(repaired[-1]["text"]) + text
            else:
                pending_text += text
            continue
        if pending_text:
            item["text"] = pending_text + text
            pending_text = ""
        repaired.append(item)
    if pending_text:
        if not repaired:
            raise ValueError("声学对齐只返回零时长字幕，无法生成可靠时间轴。")
        repaired[-1]["text"] = str(repaired[-1]["text"]) + pending_text
    return repaired


def repair_zero_duration_words(words: Sequence[TimedWord]) -> list[TimedWord]:
    repaired: list[TimedWord] = []
    pending: list[TimedWord] = []
    for word in words:
        if word.end - word.start <= 1e-6:
            if repaired and word.start <= repaired[-1].end + 1e-6:
                previous = repaired[-1]
                repaired[-1] = TimedWord(
                    previous.text + word.text,
                    previous.start,
                    previous.end,
                    previous.probability,
                    word.boundary_after or previous.boundary_after,
                )
            else:
                pending.append(word)
            continue
        if pending:
            word = TimedWord(
                "".join(item.text for item in pending) + word.text,
                word.start,
                word.end,
                word.probability,
                word.boundary_after,
            )
            pending = []
        repaired.append(word)
    if pending:
        if not repaired:
            raise ValueError("声学对齐只返回零时长词，无法生成可靠时间轴。")
        previous = repaired[-1]
        repaired[-1] = TimedWord(
            previous.text + "".join(item.text for item in pending),
            previous.start,
            previous.end,
            previous.probability,
            pending[-1].boundary_after or previous.boundary_after,
        )
    return repaired


def mean_word_probability(words: Iterable[TimedWord]) -> float:
    probabilities = [
        word.probability for word in words if word.probability is not None
    ]
    return sum(probabilities) / len(probabilities) if probabilities else 0.0


def _low_confidence_ratio(
    words: Sequence[TimedWord], threshold: float = 0.55
) -> float:
    if not words:
        return 1.0
    low_count = sum(
        1
        for word in words
        if word.probability is not None and word.probability < threshold
    )
    return low_count / len(words)


def _join_words(words: Sequence[TimedWord], language: str) -> str:
    separator = " " if language in {"en", "ko"} else ""
    return separator.join(word.text for word in words)


def _extract_words(result, language: str) -> list[TimedWord]:
    words: list[TimedWord] = []
    for segment in result.segments:
        segment_words = getattr(segment, "words", None)
        if segment_words:
            for word in segment_words:
                raw_text = str(word.word)
                text = format_display_text(raw_text)
                if not text:
                    continue
                probability = getattr(word, "probability", None)
                words.append(
                    TimedWord(
                        text=text,
                        start=float(word.start),
                        end=float(word.end),
                        probability=(
                            float(probability) if probability is not None else None
                        ),
                        boundary_after=_boundary_after(raw_text),
                    )
                )
            continue
        raw_text = str(segment.text)
        text = format_display_text(raw_text)
        if text:
            words.append(
                TimedWord(
                    text=text,
                    start=float(segment.start),
                    end=float(segment.end),
                    probability=None,
                    boundary_after=_boundary_after(raw_text),
                )
            )
    return words


def _punctuated_text(result, language: str) -> str:
    sentence_end = "." if language in {"en", "ko"} else "。"
    endings = frozenset("。！？!?….")
    parts: list[str] = []
    for segment in result.segments:
        text = str(segment.text).strip()
        if not text:
            continue
        if text[-1] not in endings:
            text += sentence_end
        parts.append(text)
    return "".join(parts)


def _punctuated_text_from_words(words: Sequence[TimedWord], language: str) -> str:
    sentence_end = "." if language in {"en", "ko"} else "。"
    phrase_end = "," if language in {"en", "ko"} else "、"
    parts: list[str] = []
    for word in words:
        token = word.text
        if word.boundary_after == "hard":
            token += sentence_end
        elif word.boundary_after == "medium":
            token += phrase_end
        parts.append(token)
    separator = " " if language in {"en", "ko"} else ""
    text = separator.join(parts).strip()
    if text and text[-1] not in frozenset("。！？!?…."):
        text += sentence_end
    return text


def _normalize_for_equality(text: str, language: str) -> str:
    normalized = format_display_text(unicodedata.normalize("NFKC", text))
    if language in {"zh", "ja"}:
        return re.sub(r"\s+", "", normalized)
    return re.sub(r"\s+", "", normalized).lower()


def _mode_a_near_match(expected: str, actual: str) -> bool:
    if not expected or not actual:
        return False
    ratio = SequenceMatcher(None, expected, actual).ratio()
    length_delta = abs(len(expected) - len(actual))
    max_delta = max(8, len(expected) // 25)
    min_ratio = 0.92 if len(expected) >= 40 else 0.88
    return ratio >= min_ratio and length_delta <= max_delta


def _split_text_by_weights(text: str, weights: Sequence[int]) -> list[str]:
    if not weights:
        return []
    if not text:
        return ["" for _ in weights]
    total = sum(max(1, int(weight)) for weight in weights) or len(weights)
    raw = [len(text) * max(1, int(weight)) / total for weight in weights]
    lengths = [int(value) for value in raw]
    remainders = sorted(
        range(len(weights)),
        key=lambda index: raw[index] - lengths[index],
        reverse=True,
    )
    missing = len(text) - sum(lengths)
    for index in range(missing):
        lengths[remainders[index % len(lengths)]] += 1
    parts: list[str] = []
    cursor = 0
    for length in lengths:
        parts.append(text[cursor : cursor + length])
        cursor += length
    return parts


def _rebase_segments_to_source_text(
    segments: Sequence[dict[str, float | str]],
    source_text: str,
    language: str,
) -> list[dict[str, float | str]]:
    """Keep segment timings, rewrite texts so Mode A still ships the user script."""
    normalized_source = _normalize_for_equality(source_text, language)
    weights = [
        max(1, len(_normalize_for_equality(str(item["text"]), language)))
        for item in segments
    ]
    pieces = _split_text_by_weights(normalized_source, weights)
    rebased: list[dict[str, float | str]] = []
    for item, piece in zip(segments, pieces):
        text = piece
        old = str(item["text"]).strip()
        if (
            text
            and old
            and old[-1] in "。！？!?、，,"
            and text[-1] not in "。！？!?、，,"
        ):
            text += old[-1]
        rebased.append({**item, "text": text})
    return rebased


def _ensure_mode_a_preserves_source(
    segments: list[dict[str, float | str]],
    source_text: str,
    language: str,
    *,
    compute_type: str,
) -> list[dict[str, float | str]]:
    expected = _normalize_for_equality(source_text, language)
    actual = _normalize_for_equality(
        "".join(str(item["text"]) for item in segments),
        language,
    )
    if actual == expected:
        return segments
    if compute_type == "int8" and _mode_a_near_match(expected, actual):
        rebased = _rebase_segments_to_source_text(segments, source_text, language)
        rebased_actual = _normalize_for_equality(
            "".join(str(item["text"]) for item in rebased),
            language,
        )
        if rebased_actual == expected:
            return rebased
    raise ValueError("模式 A 对齐结果未完整保留用户文案。")


def _validate_final_segments(
    segments: Sequence[dict[str, float | str]],
    *,
    language: str,
) -> None:
    if not segments:
        raise ValueError("精准 SRT 没有生成字幕片段。")
    limits = DISPLAY_LIMITS[language]
    previous_end = -1.0
    for index, segment in enumerate(segments, start=1):
        text = str(segment["text"]).strip()
        start = float(segment["start"])
        end = float(segment["end"])
        if not text:
            raise ValueError(f"第 {index} 条字幕为空。")
        if end <= start:
            raise ValueError(f"第 {index} 条字幕不是正时长。")
        if start + 1e-6 < previous_end:
            raise ValueError(f"第 {index} 条字幕时间轴发生重叠或倒退。")
        if end - start > 3.001:
            raise ValueError(f"第 {index} 条字幕超过 3 秒。")
        chars = len(re.sub(r"\s+", "", text))
        if chars > int(limits["max_chars"]):
            raise ValueError(f"第 {index} 条字幕超过语言字符上限。")
        max_words = limits["max_words"]
        if max_words is not None and len(text.split()) > int(max_words):
            raise ValueError(f"第 {index} 条英文字幕超过单词上限。")
        previous_end = end


def _resolve_detected_language(result, requested_language: str) -> str:
    if requested_language != "auto":
        return requested_language
    detected = normalize_language(str(getattr(result, "language", "")))
    if detected == "auto":
        raise ValueError("语音识别没有返回可用语言。")
    return detected


def prepare_alignment_text(text: str, language: str) -> str:
    if language != "ja":
        return text
    from janome.tokenizer import Tokenizer

    surfaces = [token.surface for token in Tokenizer().tokenize(text) if token.surface]
    return " ".join(surfaces)


def _transcribe_original(
    model,
    audio_path: str,
    requested_language: str,
    *,
    audio_duration_s: float | None = None,
):
    prompt = BUILTIN_PROMPTS.get(requested_language) or None
    return model.transcribe(
        audio_path,
        language=None if requested_language == "auto" else requested_language,
        regroup=False,
        beam_size=5,
        condition_on_previous_text=bool(
            audio_duration_s is not None and audio_duration_s <= 60.0
        ),
        temperature=0.0,
        vad_filter=False,
        chunk_length=30,
        initial_prompt=prompt,
        verbose=None,
    )


def _align_text(
    model,
    audio_path: str,
    text: str,
    language: str,
    *,
    tokenize_japanese: bool = False,
):
    stable_language = {
        "zh": "Chinese",
        "en": "English",
        "ja": "Japanese",
        "ko": "Korean",
    }[language]
    return model.align(
        audio_path,
        prepare_alignment_text(text, language) if tokenize_japanese else text,
        language=stable_language,
        original_split=False,
        regroup=False,
        verbose=None,
    )


def _refine_oversized_aligned_words(
    model,
    audio_path: str,
    words: Sequence[TimedWord],
    language: str,
) -> list[TimedWord]:
    limits = DISPLAY_LIMITS[language]
    oversized = [
        word
        for word in words
        if len(re.sub(r"\s+", "", word.text)) > int(limits["max_chars"])
        or word.end - word.start > 3.0
    ]
    if not oversized or language != "ja":
        return list(words)

    from janome.tokenizer import Tokenizer

    tokenizer = Tokenizer()
    samples, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    refined_words: list[TimedWord] = []
    with tempfile.TemporaryDirectory(prefix="koubox-srt-realign-") as temporary:
        for word in words:
            if word not in oversized:
                refined_words.append(word)
                continue
            tokens = [token.surface for token in tokenizer.tokenize(word.text) if token.surface]
            if len(tokens) < 2:
                refined_words.append(word)
                continue
            start_frame = max(0, min(len(samples), round(word.start * sample_rate)))
            end_frame = max(start_frame + 1, min(len(samples), round(word.end * sample_rate)))
            crop_path = Path(temporary) / f"oversized-{len(refined_words)}.wav"
            sf.write(crop_path, samples[start_frame:end_frame], sample_rate)
            local_result = _align_text(
                model,
                str(crop_path),
                " ".join(tokens),
                language,
            )
            local_words = repair_zero_duration_words(
                _extract_words(local_result, language)
            )
            if (
                len(local_words) < 2
                or _normalize_for_equality(
                    _join_words(local_words, language), language
                )
                != _normalize_for_equality(word.text, language)
            ):
                refined_words.extend(
                    _split_aligned_word_by_tokens(word, tokens)
                )
                continue
            crop_start = start_frame / sample_rate
            for local_word in local_words:
                refined_words.append(
                    TimedWord(
                        local_word.text,
                        max(word.start, crop_start + local_word.start),
                        min(word.end, crop_start + local_word.end),
                        local_word.probability,
                        local_word.boundary_after,
                    )
                )
    safe_words: list[TimedWord] = []
    for refined in refined_words:
        if (
            len(re.sub(r"\s+", "", refined.text)) <= int(limits["max_chars"])
            and refined.end - refined.start <= 3.0
        ):
            safe_words.append(refined)
            continue
        tokens = [
            token.surface
            for token in tokenizer.tokenize(refined.text)
            if token.surface
        ]
        safe_words.extend(_split_aligned_word_by_tokens(refined, tokens))
    return safe_words


def _split_aligned_word_by_tokens(
    word: TimedWord, tokens: Sequence[str]
) -> list[TimedWord]:
    """Last-resort token-boundary fallback for a stable-ts oversized word.

    This never splits a Janome token internally. It is only used when local
    acoustic realignment of an oversized stable-ts span did not return a
    usable token sequence; the span's original acoustic interval is retained
    and apportioned across complete tokens by token length.
    """
    clean_tokens = [str(token) for token in tokens if str(token).strip()]
    if len(clean_tokens) < 2 or word.end <= word.start:
        return [word]
    weights = [max(1, len(token)) for token in clean_tokens]
    total = sum(weights)
    cursor = word.start
    result: list[TimedWord] = []
    for index, (token, weight) in enumerate(zip(clean_tokens, weights)):
        end = word.end if index == len(clean_tokens) - 1 else cursor + (word.end - word.start) * weight / total
        result.append(
            TimedWord(
                token,
                cursor,
                end,
                word.probability,
                word.boundary_after if index == len(clean_tokens) - 1 else None,
            )
        )
        cursor = end
    return result


def enforce_aligned_word_limits(
    words: Sequence[TimedWord], language: str
) -> list[TimedWord]:
    """Guarantee that post-repair aligned words are segmentable.

    stable-ts can re-coalesce adjacent tokens after a local realignment or
    zero-duration repair. Re-run the same language-aware boundary policy at
    this final seam so mode A and mode B share one hard invariant.
    """
    limits = DISPLAY_LIMITS[language]
    if language != "ja":
        return list(words)
    from janome.tokenizer import Tokenizer

    tokenizer = Tokenizer()
    result: list[TimedWord] = []
    for word in words:
        if (
            len(re.sub(r"\s+", "", word.text)) <= int(limits["max_chars"])
            and word.end - word.start <= 3.0
        ):
            result.append(word)
            continue
        tokens = [token.surface for token in tokenizer.tokenize(word.text) if token.surface]
        result.extend(_split_aligned_word_by_tokens(word, tokens))
    return result
