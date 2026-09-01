from __future__ import annotations

from pathlib import Path

import torch
from faster_whisper import WhisperModel

from .log import write as log_write
from .protocol import fail, send


WHISPER_LANGUAGE_MAP = {
    "zh-Hans": "zh",
    "zh-Hant": "zh",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
}


def run(
    model_directory: str,
    audio_path: str,
    language: str = "auto",
    chunk_length_s: float = 30,
    compute_type: str = "float16",
) -> None:
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行语音识别。")
        return
    if not Path(model_directory).is_dir() or not Path(audio_path).is_file():
        fail("INPUT_NOT_FOUND", "ASR 模型目录或音频文件不存在。")
        return

    model_label = "Faster-Whisper Large-v3（FP16）" if compute_type == "float16" else "faster-whisper-large-v3-turbo（INT8）"
    send("progress", stage="loading-model", percent=5, message=f"正在加载 {model_label}")
    model = WhisperModel(model_directory, device="cuda", compute_type=compute_type)
    send("progress", stage="transcribing", percent=18, message="正在识别音频")

    whisper_language = WHISPER_LANGUAGE_MAP.get(language)
    if whisper_language:
        log_write("info", "asr", f"强制语种: {whisper_language}")
    else:
        log_write("info", "asr", "语种: auto")

    chunks, info = model.transcribe(
        audio_path,
        language=whisper_language,
        task="transcribe",
        beam_size=5,
        condition_on_previous_text=False,
        temperature=0.0,
        vad_filter=False,
        chunk_length=max(1, int(chunk_length_s)),
    )
    segments: list[dict[str, float | str]] = []
    for chunk in chunks:
        text = chunk.text.strip()
        if text:
            segments.append({"text": text, "start": float(chunk.start), "end": float(chunk.end)})
    send("progress", stage="transcribing", percent=95, message="正在整理识别结果")
    send("transcript", language=whisper_language or info.language or "und", segments=segments)
