from __future__ import annotations

import json
import sys
import traceback

from .asr import run as run_asr
from .log import write as log_write
from .protocol import fail
from .precise_srt_worker import run as run_precise_srt
from .separate import run as run_separate
from .translate import run as run_translate


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line.lstrip("\ufeff"))
            operation = request.get("operation")
            log_write("info", "runtime", f"收到操作: {operation}")
            if operation == "asr":
                run_asr(
                    request["modelDirectory"],
                    request["audioPath"],
                    language=request.get("language", "auto"),
                    chunk_length_s=float(request.get("chunkLengthS", 30)),
                    compute_type=str(request.get("computeType", "float16")),
                )
            elif operation == "precise_srt":
                run_precise_srt(
                    request["modelDirectory"],
                    request["audioPath"],
                    mode=str(request["mode"]),
                    source_text=request.get("sourceText"),
                    language=str(request.get("language", "auto")),
                    speech_rate_mode=str(request.get("speechRateMode", "auto")),
                    ffmpeg_executable=str(request["ffmpegExecutable"]),
                    compute_type=str(request.get("computeType", "float16")),
                )
            elif operation == "separate":
                run_separate(
                    request["audioPath"],
                    request["vocalsPath"],
                    models_directory=request["modelsDirectory"],
                    model_name='htdemucs',
                )
            elif operation == "translate":
                run_translate(
                    request["modelDirectory"],
                    request.get("text", ""),
                    target_language=request.get("targetLanguage", "zh-Hans"),
                    temperature=float(request.get("temperature", 0.7)),
                    max_new_tokens=int(request.get("maxNewTokens", 4096)),
                    top_p=float(request.get("topP", 0.8)),
                    lines=request.get("lines"),
                    source_language=str(request.get("sourceLanguage") or ""),
                )
            else:
                fail("INVALID_OPERATION", f"不支持的本地运行操作：{operation}")
        except Exception as error:
            log_write("error", "runtime", str(error), traceback.format_exc())
            fail("RUNTIME_ERROR", str(error))
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
