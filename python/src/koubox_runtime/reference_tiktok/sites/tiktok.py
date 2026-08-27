from __future__ import annotations

import re

from .base import DownloadOptions, DownloadResult, DownloadTarget, LogCallback
from .ytdlp_common import base_ytdlp_cmd, run_ytdlp_capture
from ..settings import settings


TIKTOK_VIDEO_RE = re.compile(r"https?://(?:www\.)?tiktok\.com/@[^/\s]+/video/\d+")


class TikTokDownloader:
    site_key = "tiktok"
    display_name = "TikTok"
    profile_placeholder = "https://www.tiktok.com/@username"
    video_placeholder = "每行一个视频链接，例如：https://www.tiktok.com/@username/video/123"

    def resolve_targets(self, options: DownloadOptions, log: LogCallback) -> list[DownloadTarget]:
        if options.mode == "videos":
            return [DownloadTarget(url=url, label=f"video-{index}") for index, url in enumerate(options.video_urls, start=1)]

        if not options.profile_url:
            raise ValueError("请填写 TikTok 用户主页链接。")

        log("正在解析 TikTok 用户主页作品列表...")
        cmd = base_ytdlp_cmd()
        cmd.extend(["--flat-playlist", "--ignore-errors", "--print", "%(webpage_url)s"])
        if options.limit:
            cmd.extend(["--playlist-end", str(options.limit)])
        cmd.append(options.profile_url)
        completed = run_ytdlp_capture(cmd, log)
        urls = self._extract_video_urls(completed.output)
        if completed.returncode != 0 and not urls:
            raise RuntimeError(f"主页解析失败，yt-dlp exit code={completed.returncode}。")
        if urls:
            log(f"已解析到 {len(urls)} 个作品，开始按线程数下载。")
            return [DownloadTarget(url=url, label=f"video-{index}") for index, url in enumerate(urls, start=1)]
        log("没有拿到独立视频链接，将回退为整页 playlist 下载。")
        return [DownloadTarget(url=options.profile_url, label="profile-playlist")]

    def download_target(self, target: DownloadTarget, options: DownloadOptions, log: LogCallback) -> DownloadResult:
        options.output_dir.mkdir(parents=True, exist_ok=True)
        settings.archive_dir.mkdir(parents=True, exist_ok=True)
        archive = settings.archive_dir / f"{options.output_dir.name}.txt"
        output_template = "%(uploader|unknown_uploader)s/%(upload_date>%Y-%m-%d|unknown_date)s_%(id)s_%(title).80B.%(ext)s"
        cmd = base_ytdlp_cmd()
        playlist_flag = "--yes-playlist" if target.label == "profile-playlist" else "--no-playlist"
        cmd.extend([
            playlist_flag, "--ignore-errors", "--no-overwrites", "--continue",
            "--download-archive", str(archive), "--sleep-interval", "1", "--max-sleep-interval", "4",
            "--retries", "3", "--fragment-retries", "3", "--extractor-retries", "3",
            "--file-access-retries", "3", "--retry-sleep", "exp=1:20", "--concurrent-fragments", "1",
            "--format", "bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4][vcodec!=none]/bv*[ext=mp4]",
            "--restrict-filenames", "--trim-filenames", "180", "--merge-output-format", "mp4",
            "-P", str(options.output_dir), "-o", output_template, target.url,
        ])
        if settings.save_info_json:
            cmd.append("--write-info-json")
        if settings.save_thumbnail:
            cmd.extend(["--write-thumbnail", "--convert-thumbnails", "jpg"])
        result = run_ytdlp_capture(cmd, log)
        skipped = "has already been recorded in the archive" in result.output
        return DownloadResult(ok=result.returncode == 0, skipped=skipped, returncode=result.returncode, output=result.output)

    def _extract_video_urls(self, output: str) -> list[str]:
        seen: set[str] = set()
        urls: list[str] = []
        for match in TIKTOK_VIDEO_RE.finditer(output):
            url = match.group(0)
            if url not in seen:
                seen.add(url)
                urls.append(url)
        return urls
