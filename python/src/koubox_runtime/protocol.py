from __future__ import annotations

import json
import sys
from typing import Any

from .log import write as log_write


def send(message_type: str, **payload: Any) -> None:
    message = {"type": message_type, **payload}
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str) -> None:
    log_write("error", "runtime", message, {"code": code})
    send("error", code=code, message=message)
