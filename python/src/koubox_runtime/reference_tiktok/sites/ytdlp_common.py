from __future__ import annotations

import os
import subprocess
import sys

from .base import DownloadResult, LogCallback


def base_ytdlp_cmd() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--ytdlp"]
    return [sys.executable, "-m", "yt_dlp"]


def run_ytdlp_capture(cmd: list[str], log: LogCallback) -> DownloadResult:
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        creationflags=creationflags,
    )

    lines: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        clean = line.rstrip()
        if clean:
            log(clean)
            lines.append(clean)
    returncode = proc.wait()
    return DownloadResult(ok=returncode == 0, skipped=False, returncode=returncode, output="\n".join(lines[-300:]))
