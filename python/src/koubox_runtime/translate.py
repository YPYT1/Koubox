from __future__ import annotations

from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .protocol import fail, send


def clean_translation(text: str) -> str:
    value = text.strip()
    for prefix in ("翻译：", "译文：", "Translation:", "中文翻译："):
        if value.startswith(prefix):
            value = value[len(prefix):].lstrip()
    return value.strip()


def run(model_directory: str, text: str) -> None:
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行翻译。")
        return
    if not Path(model_directory).is_dir():
        fail("MODEL_NOT_FOUND", "HYMT21.8B 模型目录不存在。")
    if not text.strip():
        fail("EMPTY_TEXT", "没有可翻译的原文。")
        return

    send("progress", stage="loading-model", percent=5, message="正在加载 HYMT21.8B")
    tokenizer = AutoTokenizer.from_pretrained(model_directory, local_files_only=True, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_directory,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        local_files_only=True,
        trust_remote_code=True,
    )
    model.eval()
    prompt = f"将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
    messages = [{"role": "user", "content": prompt}]
    encoded = tokenizer.apply_chat_template(messages, add_generation_prompt=True, return_tensors="pt")
    if hasattr(encoded, "to"):
        encoded = encoded.to(model.device)
    if isinstance(encoded, dict):
        input_ids = encoded["input_ids"]
        output = model.generate(**encoded, max_new_tokens=4096, temperature=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05)
    else:
        input_ids = encoded
        output = model.generate(encoded, max_new_tokens=4096, temperature=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05)
    result = tokenizer.decode(output[0][input_ids.shape[-1]:], skip_special_tokens=True)
    send("progress", stage="translating", percent=95, message="正在整理译文")
    send("translation", text=clean_translation(result))
