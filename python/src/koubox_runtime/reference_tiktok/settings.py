from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import sys


def resolve_project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


PROJECT_ROOT = resolve_project_root()


def resolve_instagram_cookies_file() -> Path | None:
    env_path = os.environ.get("VIDEO_DOWNLOADER_INSTAGRAM_COOKIES")
    if env_path:
        return Path(env_path).expanduser()
    for filename in ("instagram_cookies.txt", "cookies.txt"):
        candidate = PROJECT_ROOT / filename
        if candidate.exists():
            return candidate
    return None


@dataclass(frozen=True)
class Settings:
    output_dir: Path = PROJECT_ROOT / "video_downloads"
    logs_dir: Path = PROJECT_ROOT / "logs"
    archive_dir: Path = PROJECT_ROOT / ".runtime" / "download_archives"
    default_threads: int = 10
    max_threads: int = 64
    default_retries: int = 5
    max_retries: int = 6
    save_info_json: bool = False
    save_thumbnail: bool = False
    keep_only_mp4: bool = True
    instagram_cookies_file: Path | None = resolve_instagram_cookies_file()
    instagram_profile_cache_file: Path = PROJECT_ROOT / ".runtime" / "instagram_profile_cache.json"
    instagram_allow_search_fallback: bool = False
    instagram_allow_helper_fallback: bool = False
    instagram_user_id_cache: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.instagram_user_id_cache is None:
            object.__setattr__(self, "instagram_user_id_cache", {"kiyotaka_i420": "12459327338"})


settings = Settings()
