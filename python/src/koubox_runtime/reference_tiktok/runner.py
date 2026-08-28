from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import shutil
import sys

from .sites.base import DownloadOptions, DownloadTarget
from .sites.tiktok import TikTokDownloader
from .sites import tiktok as tiktok_module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--file-stem", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = output_dir / ".archive"
    tiktok_module.settings = replace(tiktok_module.settings, archive_dir=archive_dir)
    options = DownloadOptions(
        site="tiktok", mode="videos", profile_url=None, video_urls=[args.url],
        output_dir=output_dir, threads=1, retries=3,
    )
    downloader = TikTokDownloader()
    result = downloader.download_target(DownloadTarget(url=args.url, label="video-1"), options, print)
    if not result.ok:
        print("RESULT_JSON=" + json.dumps({"ok": False, "returncode": result.returncode, "output": result.output}, ensure_ascii=False))
        return result.returncode or 1
    candidates = [
        path for path in output_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}
        and not path.name.startswith(args.file_stem)
    ]
    if not candidates:
        print("RESULT_JSON=" + json.dumps({"ok": False, "returncode": 1, "output": "yt-dlp completed without a media file"}, ensure_ascii=False))
        return 1
    source = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    target = output_dir / f"{args.file_stem}{source.suffix.lower()}"
    if target.exists():
        target.unlink()
    shutil.move(str(source), str(target))
    print("RESULT_JSON=" + json.dumps({"ok": True, "path": str(target), "returncode": 0}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
