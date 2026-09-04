from __future__ import annotations

from pathlib import Path

import ctranslate2
from transformers import AutoTokenizer

from .log import write as log_write
from .protocol import fail, send

NLLB_SRC_LANG = {
    "ja": "jpn_Jpan",
    "jp": "jpn_Jpan",
    "japanese": "jpn_Jpan",
    "en": "eng_Latn",
    "english": "eng_Latn",
    "ko": "kor_Hang",
    "korean": "kor_Hang",
}
NLLB_TGT_LANG = "zho_Hans"


def _resolve_source_language(source_language: str) -> str | None:
    normalized = (source_language or "").strip().lower().replace("_", "-")
    if not normalized:
        fail("SOURCE_LANGUAGE_REQUIRED", "缺少源语言，无法选择 NLLB 翻译方向。")
        return None
    primary = normalized.split("-", 1)[0]
    mapped = NLLB_SRC_LANG.get(normalized) or NLLB_SRC_LANG.get(primary)
    if not mapped:
        fail(
            "UNSUPPORTED_SOURCE_LANGUAGE",
            f"当前识别语种「{source_language}」不支持翻译，仅支持日语 / 英语 / 韩语 → 简体中文。",
        )
        return None
    return mapped


def _translate_one(
    translator: ctranslate2.Translator,
    tokenizer: AutoTokenizer,
    text: str,
    src_lang: str,
) -> str:
    tokenizer.src_lang = src_lang
    token_ids = tokenizer.encode(text, add_special_tokens=True)
    source_tokens = tokenizer.convert_ids_to_tokens(token_ids)
    result = translator.translate_batch(
        [source_tokens],
        target_prefix=[[NLLB_TGT_LANG]],
        beam_size=4,
        max_decoding_length=128,
        repetition_penalty=1.2,
    )[0].hypotheses[0]
    body = result[1:] if result and result[0] == NLLB_TGT_LANG else result
    decoded = tokenizer.decode(
        tokenizer.convert_tokens_to_ids(body),
        skip_special_tokens=True,
    ).strip()
    return decoded.replace("潤", "润")


def run(
    model_directory: str,
    text: str,
    target_language: str = "zh-Hans",
    temperature: float = 0.7,
    max_new_tokens: int = 4096,
    top_p: float = 0.8,
    lines: list[str] | None = None,
    source_language: str = "",
) -> None:
    del temperature, max_new_tokens, top_p
    if target_language != "zh-Hans":
        fail("INVALID_TARGET_LANGUAGE", f"当前模型仅支持简体中文，收到：{target_language}")
        return
    if not Path(model_directory).is_dir():
        fail("MODEL_NOT_FOUND", "NLLB CT2 翻译模型目录不存在。")
        return

    source_lines = list(lines) if lines is not None else text.splitlines()
    source_lines = [item.strip() if isinstance(item, str) else "" for item in source_lines]
    if not any(line for line in source_lines):
        fail("EMPTY_TEXT", "没有可翻译的原文。")
        return

    src_lang = _resolve_source_language(source_language)
    if not src_lang:
        return

    send("progress", stage="loading-model", percent=5, message="正在加载 NLLB 翻译模型")
    tokenizer = AutoTokenizer.from_pretrained(model_directory, local_files_only=True)
    translator = ctranslate2.Translator(model_directory, device="cuda", compute_type="float16")

    total = len(source_lines)
    translated: list[str] = []
    log_write("info", "translate", f"NLLB 逐句翻译开始，共 {total} 句，src={src_lang}")

    for index, line in enumerate(source_lines):
        percent = 8 + int((index / max(total, 1)) * 86)
        send("progress", stage="translating", percent=percent, message=f"正在翻译第 {index + 1}/{total} 句")
        if not line:
            translated_line = ""
        else:
            translated_line = _translate_one(translator, tokenizer, line, src_lang)
            if not translated_line:
                fail("TRANSLATION_EMPTY", f"第 {index + 1} 句没有生成有效译文。")
                return
        translated.append(translated_line)
        send(
            "translation-line",
            lineIndex=index,
            totalLines=total,
            text=translated_line,
            percent=percent,
        )

    del translator

    if len(translated) != total:
        fail("TRANSLATION_ALIGN", f"译文行数与原文不一致：原文 {total} 行，译文 {len(translated)} 行。")
        return

    send("progress", stage="translating", percent=95, message="正在整理译文")
    send(
        "translation",
        text="\n".join(line for line in translated if line),
        translatedLines=translated,
    )
