from __future__ import annotations

from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .protocol import fail, send


TARGET_PROMPTS = {
    "zh-Hans": "将以下文本翻译为简体中文，注意只需要输出原文翻译后的结果，不要添加任何额外解释和润色：",
    "zh-Hant": "将以下文本翻译为繁体中文，注意只需要输出原文翻译后的结果，不要添加任何额外解释和润色：",
    "en": "Translate the following text into English. Output only the translation, without explanations or polishing:",
    "ja": "次のテキストを日本語に翻訳してください。翻訳結果のみを出力し、説明や潤色は不要です：",
    "ko": "다음 텍스트를 한국어로 번역하세요. 번역 결과만 출력하고 설명이나 다듬기는 하지 마세요:",
}


def clean_translation(text: str) -> str:
    value = text.strip()
    for prefix in (
        "翻译：",
        "译文：",
        "Translation:",
        "中文翻译：",
        "繁体翻译：",
        "日本語訳：",
        "번역:",
    ):
        if value.startswith(prefix):
            value = value[len(prefix):].lstrip()
    return value.strip()


def run(
    model_directory: str,
    text: str,
    target_language: str = "zh-Hans",
    temperature: float = 0.7,
    max_new_tokens: int = 4096,
    top_p: float = 0.8,
) -> None:
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行翻译。")
        return
    if not Path(model_directory).is_dir():
        fail("MODEL_NOT_FOUND", "Hy-MT2-1.8B 模型目录不存在。")
        return
    if not text.strip():
        fail("EMPTY_TEXT", "没有可翻译的原文。")
        return
    prompt_prefix = TARGET_PROMPTS.get(target_language)
    if not prompt_prefix:
        fail("INVALID_TARGET_LANGUAGE", f"不支持的目标语言：{target_language}")
        return

    send("progress", stage="loading-model", percent=5, message="正在加载 Hy-MT2-1.8B")
    tokenizer = AutoTokenizer.from_pretrained(model_directory, local_files_only=True, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_directory,
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        trust_remote_code=True,
    ).to("cuda:0")
    model.eval()
    prompt = f"{prompt_prefix}\n\n{text}"
    messages = [{"role": "user", "content": prompt}]
    encoded = tokenizer.apply_chat_template(
        messages,
        add_generation_prompt=True,
        return_tensors="pt",
        return_dict=True,
    ).to(model.device)
    input_ids = encoded["input_ids"]
    output = model.generate(
        **encoded,
        do_sample=True,
        max_new_tokens=int(max_new_tokens),
        temperature=float(temperature),
        top_p=float(top_p),
        top_k=20,
        repetition_penalty=1.05,
    )
    result = tokenizer.decode(output[0][input_ids.shape[-1]:], skip_special_tokens=True)
    send("progress", stage="translating", percent=95, message="正在整理译文")
    send("translation", text=clean_translation(result))
