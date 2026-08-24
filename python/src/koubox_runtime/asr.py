from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

from .protocol import fail, send


WHISPER_LANGUAGE_MAP = {
    "zh-Hans": "zh",
    "zh-Hant": "zh",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
}


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("ASR 输入音频必须是单声道 16-bit WAV。")
        sample_rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0, sample_rate


def run(model_directory: str, audio_path: str, language: str = "auto", chunk_length_s: float = 30) -> None:
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行语音识别。")
        return
    if not Path(model_directory).is_dir() or not Path(audio_path).is_file():
        fail("INPUT_NOT_FOUND", "ASR 模型目录或音频文件不存在。")
        return

    send("progress", stage="loading-model", percent=5, message="正在加载 Whisper 模型")
    device = "cuda:0"
    dtype = torch.float16
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        model_directory,
        torch_dtype=dtype,
        use_safetensors=True,
        local_files_only=True,
    ).to(device)
    processor = AutoProcessor.from_pretrained(model_directory, local_files_only=True)
    recognizer = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        chunk_length_s=float(chunk_length_s),
        device=0,
        torch_dtype=dtype,
    )
    audio, sample_rate = read_wav(audio_path)
    send("progress", stage="transcribing", percent=18, message="正在识别音频")
    generate_kwargs: dict[str, object] = {
        "task": "transcribe",
        "condition_on_prev_tokens": False,
    }
    whisper_language = WHISPER_LANGUAGE_MAP.get(language)
    if whisper_language:
        generate_kwargs["language"] = whisper_language
    result = recognizer(
        {"array": audio, "sampling_rate": sample_rate},
        return_timestamps=True,
        generate_kwargs=generate_kwargs,
    )
    segments: list[dict[str, float | str]] = []
    for chunk in result.get("chunks", []):
        timestamp = chunk.get("timestamp") or [None, None]
        start, end = timestamp[0], timestamp[1]
        text = str(chunk.get("text", "")).strip()
        if text and start is not None and end is not None:
            segments.append({"text": text, "start": float(start), "end": float(end)})
    if not segments and str(result.get("text", "")).strip():
        duration = len(audio) / sample_rate
        segments.append({"text": str(result["text"]).strip(), "start": 0.0, "end": duration})
    detected = getattr(result, "language", None) or result.get("language")
    if language != "auto":
        detected = language
    send("progress", stage="transcribing", percent=95, message="正在整理识别结果")
    send("transcript", language=detected or "und", segments=segments)
