from __future__ import annotations

from pathlib import Path
import re

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .log import write as log_write
from .protocol import fail, send


# 口播/短视频：先校日后翻译；准确优先。
TARGET_PROMPTS = {
    "zh-Hans": """你是日语短视频字幕译者。将【当前句】译为简体中文。

硬性要求：
1. 只输出这一句的译文，单行，不要编号、不要解释、不要合并其它句。
2. 严格对应【当前句】：原文没有的数字、金额、公司、事件，译文里一个都不要加。
3. 短标题按字面译：緊急速報＝紧急速报。不要写成新闻套话，更不要编造注资、万亿、日元。
4. 「最終的なX」＝「终极X」。禁止套用「最后一道底牌」（那是「最後の砦」专属译法）。
5. 仅当原文出现该词时才用下列对应：
   - 1兆円＝1万亿日元；数兆円＝数万亿日元（绝不可写成数十万亿）
   - 最後の砦＝最后一道底牌
   - 安堵のため息＝松了一口气
   - 流し込む＝大举注入
6. 句子要像中文口播：短、准、有冲击力，不要日式直译腔。
7. 只输出一个最终版本，禁止“/”“或”“()”候选写法。""",
    "zh-Hant": """你是日語財經短視頻字幕譯者。將【當前句】譯為繁體中文。

硬性要求：
1. 只輸出這一句的譯文，單行，不要編號、不要解釋、不要合併其它句。
2. 意思與語氣必須準確。
3. 日語數量單位：1兆円＝1萬億日圓；「数兆円」＝「數萬億日圓」。
4. 術語：「禁じ手」→「禁忌手段」；「砦」→「防線」；SMR →「小型模組化反應堆」。
5. 只輸出譯文本身。""",
    "en": """You are a subtitle translator for Japanese finance short videos. Translate ONLY the current sentence into English.

Rules:
1. Output one line: the translation only. No numbering, no explanations.
2. Preserve tone and intensity.
3. Numbers: 1兆円 = 1 trillion yen; 数兆円 = several trillion yen (NOT tens of trillions).
4. Terms: 禁じ手 = last-resort/taboo move; 砦 = last line of defense; SMR = small modular reactor.""",
    "ja": "次の一文を日本語に整えてください。意味を変えず、音声認識の明らかな誤りのみ文脈で修正し、その一文だけを出力してください：",
    "ko": "다음 한 문장만 한국어로 번역하세요. 해당 문장의 번역만 한 줄로 출력하세요:",
}

JA_CORRECT_PROMPT = """你是日语语音识别校对编辑。下面是 Whisper ASR 输出的一句日语，可能含同音错字、不成词假名、财经专名误听。

硬性要求：
1. 只输出校正后的这一句日语，单行，不要解释，不要翻译成中文或其他语言。
2. 保留原意与口播语气，不要扩写、不要删减关键信息。
3. 结合上下文修正明显 ASR 错误。例如：サイモの砦→最後の砦；新旧速報→最新速報；一気一流→一気に；充電メーカー（東芝・日立・三菱電機の文脈）→電機メーカー。
4. 数字、公司名、股票相关表述按日本财经口播习惯纠正；不确定时宁可保留原词，也不要胡编。"""


def clean_output(text: str) -> str:
    value = text.strip()
    for prefix in (
        "翻译：",
        "译文：",
        "譯文：",
        "校正：",
        "校对：",
        "修正：",
        "Translation:",
        "中文翻译：",
        "繁体翻译：",
        "繁體翻譯：",
        "日本語訳：",
        "번역:",
    ):
        if value.startswith(prefix):
            value = value[len(prefix):].lstrip()
    if len(value) >= 2 and value[0] in "\"'「『" and value[-1] in "\"'」』":
        value = value[1:-1].strip()
    return value.strip().replace("\r\n", "\n").replace("\n", " ").strip()


_EXACT_ZH = {
    "緊急速報": "紧急速报",
}


def _normalize_zh_line(text: str, source_line: str) -> str:
    src = source_line.strip().strip("。．.！!？?")
    if src in _EXACT_ZH:
        return _EXACT_ZH[src]
    value = text.strip()
    if not value:
        return value
    value = re.sub(r"\bolan\b", "", value, flags=re.IGNORECASE).strip()
    value = re.sub(r"([^\s/]{2,})\s*/\s*([^\s/]{2,})", r"\1", value)
    if "緊急速報" in source_line:
        if re.search(r"万亿|日元|注入|注资", value):
            return "紧急速报"
        value = value.replace("紧急新闻", "紧急速报").replace("紧急快讯", "紧急速报")
    if "最後の砦" not in source_line and "最終的" in source_line:
        value = value.replace("最后一道底牌", "终极").replace("最后一道防线", "终极")
    value = re.sub(r"\s+", " ", value).strip()
    return value


def _is_japanese_source(source_language: str, lines: list[str]) -> bool:
    normalized = (source_language or "").lower().replace("_", "-")
    if normalized.startswith("ja") or normalized in {"japanese", "jp"}:
        return True
    sample = "".join(lines)[:400]
    if not sample:
        return False
    kana_kanji = sum(1 for ch in sample if ("\u3040" <= ch <= "\u30ff") or ("\u4e00" <= ch <= "\u9fff"))
    return (kana_kanji / max(len(sample), 1)) >= 0.25


def _build_prompt(prefix: str, line: str, prev_line: str, next_line: str, output_label: str) -> str:
    parts = [prefix, "", "【上下文】（只供理解，不要输出）"]
    parts.append(f"上一句：{prev_line}" if prev_line else "上一句：（无）")
    parts.append(f"下一句：{next_line}" if next_line else "下一句：（无）")
    parts.append("")
    parts.append("【当前句】")
    parts.append(line)
    parts.append("")
    parts.append(output_label)
    return "\n".join(parts)


def _generate_one(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    prompt: str,
    temperature: float,
    max_new_tokens: int,
    top_p: float,
    line: str,
    *,
    deterministic: bool = False,
) -> str:
    messages = [{"role": "user", "content": prompt}]
    encoded = tokenizer.apply_chat_template(
        messages,
        add_generation_prompt=True,
        return_tensors="pt",
        return_dict=True,
    ).to(model.device)
    input_ids = encoded["input_ids"]
    per_line_tokens = max(64, min(int(max_new_tokens), max(160, len(line) * 4)))
    if deterministic:
        output = model.generate(
            **encoded,
            do_sample=False,
            num_beams=3,
            max_new_tokens=per_line_tokens,
        )
    else:
        sample_temperature = max(0.2, min(float(temperature), 0.55))
        output = model.generate(
            **encoded,
            do_sample=True,
            max_new_tokens=per_line_tokens,
            temperature=sample_temperature,
            top_p=min(float(top_p), 0.9),
            top_k=20,
            repetition_penalty=1.05,
        )
    result = tokenizer.decode(output[0][input_ids.shape[-1]:], skip_special_tokens=True)
    return clean_output(result)


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
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行翻译。")
        return
    if not Path(model_directory).is_dir():
        fail("MODEL_NOT_FOUND", "Hy-MT2-1.8B 模型目录不存在。")
        return

    source_lines = [item.strip() for item in (lines if lines is not None else text.splitlines()) if item.strip()]
    if not source_lines:
        fail("EMPTY_TEXT", "没有可翻译的原文。")
        return

    prompt_prefix = TARGET_PROMPTS.get(target_language)
    if not prompt_prefix:
        fail("INVALID_TARGET_LANGUAGE", f"不支持的目标语言：{target_language}")
        return

    need_ja_correct = target_language != "ja" and _is_japanese_source(source_language, source_lines)

    send("progress", stage="loading-model", percent=5, message="正在加载 Hy-MT2-1.8B")
    tokenizer = AutoTokenizer.from_pretrained(model_directory, local_files_only=True, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_directory,
        dtype=torch.bfloat16,
        local_files_only=True,
        trust_remote_code=True,
    ).to("cuda:0")
    model.eval()

    total = len(source_lines)
    corrected: list[str] = list(source_lines)

    if need_ja_correct:
        log_write("info", "translate", f"日语纠错开始，共 {total} 句")
        for index, line in enumerate(source_lines):
            percent = 6 + int((index / max(total, 1)) * 40)
            send("progress", stage="correcting", percent=percent, message=f"正在校正日语第 {index + 1}/{total} 句")
            prev_line = source_lines[index - 1] if index > 0 else ""
            next_line = source_lines[index + 1] if index + 1 < total else ""
            prompt = _build_prompt(JA_CORRECT_PROMPT, line, prev_line, next_line, "【校正后日语】")
            fixed = _generate_one(
                model,
                tokenizer,
                prompt,
                temperature,
                max_new_tokens,
                top_p,
                line,
                deterministic=True,
            )
            corrected[index] = fixed or line

    translated: list[str] = []
    log_write("info", "translate", f"逐句翻译开始，共 {total} 句（纠错={'是' if need_ja_correct else '否'}）")
    for index, line in enumerate(corrected):
        percent = (48 if need_ja_correct else 8) + int((index / max(total, 1)) * (46 if need_ja_correct else 86))
        send("progress", stage="translating", percent=percent, message=f"正在翻译第 {index + 1}/{total} 句")
        prev_line = corrected[index - 1] if index > 0 else ""
        next_line = corrected[index + 1] if index + 1 < total else ""
        prompt = _build_prompt(prompt_prefix, line, prev_line, next_line, "【译文】")
        translated_line = _generate_one(
            model,
            tokenizer,
            prompt,
            temperature,
            max_new_tokens,
            top_p,
            line,
            deterministic=False,
        )
        if target_language == "zh-Hans":
            translated_line = _normalize_zh_line(translated_line, line)
        if not translated_line:
            fail("TRANSLATION_EMPTY", f"第 {index + 1} 句没有生成有效译文。")
            return
        translated.append(translated_line)
        send(
            "translation-line",
            lineIndex=index,
            totalLines=total,
            text=translated_line,
        )

    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    if len(translated) != total:
        fail("TRANSLATION_ALIGN", f"译文行数与原文不一致：原文 {total} 行，译文 {len(translated)} 行。")
        return
    if need_ja_correct and len(corrected) != total:
        fail("CORRECTION_ALIGN", f"日语校正行数与原文不一致：原文 {total} 行，校正 {len(corrected)} 行。")
        return

    send("progress", stage="translating", percent=95, message="正在整理译文")
    payload: dict[str, object] = {
        "text": "\n".join(translated),
        # Keep the sentence boundary explicit. The desktop core must consume
        # this array by index instead of trying to infer boundaries from text.
        "translatedLines": translated,
    }
    if need_ja_correct:
        payload["correctedLines"] = corrected
    send("translation", **payload)
