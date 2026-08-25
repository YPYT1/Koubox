from __future__ import annotations

import os
from pathlib import Path

import soundfile as sf
import torch

from .log import write as log_write
from .protocol import fail, send

DEMUCS_MODEL_NAME = "htdemucs"
DEMUCS_CHECKPOINT_NAME = "955717e8-8726e21a.th"


def _htdemucs_weights_ready(models_root: Path) -> bool:
    checkpoint = models_root / "hub" / "checkpoints" / DEMUCS_CHECKPOINT_NAME
    return checkpoint.is_file() and checkpoint.stat().st_size > 0


def _load_wav(path: str) -> tuple[torch.Tensor, int]:
    data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.T.copy()), sample_rate


def _save_wav(path: Path, wav: torch.Tensor, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = wav.detach().cpu()
    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
    sf.write(str(path), audio.numpy().T, sample_rate, subtype="PCM_16")


def run(input_path: str, vocals_path: str, models_directory: str, model_name: str = DEMUCS_MODEL_NAME) -> None:
    if not torch.cuda.is_available():
        fail("GPU_REQUIRED", "当前没有可用的 NVIDIA GPU，无法执行人声分离。")
        return
    if not Path(input_path).is_file():
        fail("INPUT_NOT_FOUND", "待分离的音频文件不存在。")
        return

    # Only htdemucs is supported; ignore any other requested name.
    model_name = DEMUCS_MODEL_NAME
    models_root = Path(models_directory)
    models_root.mkdir(parents=True, exist_ok=True)
    # Force weights into <models>/demucs/hub/checkpoints/
    os.environ["TORCH_HOME"] = str(models_root)
    torch.hub.set_dir(str(models_root / "hub"))

    if _htdemucs_weights_ready(models_root):
        send("progress", percent=8, message="正在加载本地 htdemucs 模型到 GPU…")
    else:
        send(
            "progress",
            percent=8,
            message="本地尚无 htdemucs 权重，正在下载到 models/demucs（约 80MB，仅首次）…",
        )

    try:
        from demucs.apply import apply_model
        from demucs.audio import convert_audio
        from demucs.pretrained import get_model
    except ImportError as error:
        fail("DEMUCS_MISSING", f"未安装 demucs：{error}")
        return

    device = "cuda:0"
    model = get_model(name=model_name)
    model.to(device)
    model.eval()

    send("progress", percent=25, message="模型已就绪，正在读取音频并准备分离…")
    log_write("info", "separate", "读取音频", {"inputPath": input_path})
    wav, sample_rate = _load_wav(input_path)
    wav = convert_audio(wav, sample_rate, model.samplerate, model.audio_channels)
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)

    send("progress", percent=45, message="正在分离人声与背景音乐")
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, split=True, overlap=0.25, progress=False)[0]
    sources = sources * (ref.std() + 1e-8) + ref.mean()

    if "vocals" not in model.sources:
        fail("DEMUCS_OUTPUT", "当前 Demucs 模型没有 vocals 输出轨。")
        return

    vocals_index = model.sources.index("vocals")
    vocals = sources[vocals_index]

    send("progress", percent=85, message="正在写出人声轨")
    output = Path(vocals_path)
    if output.exists():
        output.unlink()
    _save_wav(output, vocals, model.samplerate)

    del sources, wav, model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    if not output.is_file() or output.stat().st_size <= 0:
        fail("DEMUCS_OUTPUT", "人声分离已结束，但没有生成有效的人声文件。")
        return

    send("separated", vocalsPath=str(output), message="人声分离完成")
