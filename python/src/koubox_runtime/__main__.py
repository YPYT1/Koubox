from __future__ import annotations

import json
import sys
import traceback

from .asr import run as run_asr
from .protocol import fail
from .translate import run as run_translate


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            operation = request.get("operation")
            if operation == "asr":
                run_asr(request["modelDirectory"], request["audioPath"])
            elif operation == "translate":
                run_translate(request["modelDirectory"], request["text"])
            else:
                fail("INVALID_OPERATION", f"不支持的本地运行操作：{operation}")
        except Exception as error:
            fail("RUNTIME_ERROR", str(error))
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
