from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Protocol


DownloadMode = Literal["profile", "videos"]
LogCallback = Callable[[str], None]


@dataclass(frozen=True)
class DownloadOptions:
    site: str
    mode: DownloadMode
    profile_url: str | None
    video_urls: list[str]
    output_dir: Path
    threads: int
    retries: int
    limit: int | None = None


@dataclass(frozen=True)
class DownloadTarget:
    url: str
    label: str


@dataclass(frozen=True)
class DownloadResult:
    ok: bool
    skipped: bool
    returncode: int
    output: str


class SiteDownloader(Protocol):
    site_key: str
    display_name: str
    profile_placeholder: str
    video_placeholder: str

    def resolve_targets(self, options: DownloadOptions, log: LogCallback) -> list[DownloadTarget]:
        """Return concrete targets to download."""

    def download_target(self, target: DownloadTarget, options: DownloadOptions, log: LogCallback) -> DownloadResult:
        """Download one target."""
