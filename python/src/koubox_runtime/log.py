from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LEVEL_ORDER = {"debug": 0, "info": 1, "warn": 2, "error": 3}

_config: dict[str, object] | None = None


def _load_config() -> dict[str, object]:
    global _config
    if _config is not None:
        return _config
    level = os.environ.get("KOUBOX_LOG_LEVEL", "info").lower()
    if level not in LEVEL_ORDER:
        level = "info"
    verbose = os.environ.get("KOUBOX_LOG_VERBOSE", "0").lower() in ("1", "true", "yes")
    log_dir = os.environ.get("KOUBOX_LOG_DIR", "")
    log_file = Path(log_dir) / "koubox.log" if log_dir else None
    _config = {"level": level, "verbose": verbose, "log_file": log_file}
    return _config


def write(level: str, component: str, message: str, detail: object | None = None) -> None:
    cfg = _load_config()
    min_level = str(cfg["level"])
    if LEVEL_ORDER.get(level, 1) < LEVEL_ORDER.get(min_level, 1):
        return
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    line = f"[{timestamp}] [{level.upper()}] [{component}] {message}"
    if detail is not None and cfg["verbose"]:
        if isinstance(detail, str):
            line += f"\n{detail}"
        else:
            line += f"\n{json.dumps(detail, ensure_ascii=False, indent=2)}"
    print(line, file=sys.stderr)
    log_file = cfg["log_file"]
    if isinstance(log_file, Path):
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
