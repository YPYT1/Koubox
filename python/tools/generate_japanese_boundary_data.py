from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "training-data" / "japanese_boundary_examples.jsonl"
SOURCE_DIR = Path(r"C:\Users\Administrator\Desktop\文案\日语")
CATEGORIES = [
    "半导体设备维护与良率",
    "工业机器人和精密传动",
    "新能源汽车热管理",
    "数据中心液冷与电力",
    "工厂视觉检测与边缘计算",
    "光通信器件与高速网络",
    "医疗器械材料与可靠性",
    "航空航天复合材料",
    "智能物流和仓储自动化",
    "低功耗传感器和无线通信",
]


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def request_generation(api_key: str, model: str, url: str, category: str, batch: int) -> list[dict[str, object]]:
    prompt = f"""
你是日语科技口播字幕数据集标注员。请生成 8 条互不重复的日语工业科技口播句子，主题是“{category}”，每条 25 到 80 个日文字符。

任务不是翻译，也不是摘要。请为每条句子同时给出自然口播字幕分段。分段必须遵守：
1. segments 按原文顺序拼接后必须逐字符等于 text。
2. 分段优先在完整语义单元、文节、自然气口处结束；不要为了固定长度切句。
3. 不得把复合词、专有名词、技术术语或连贯的名词短语从中间切开。
4. 不得留下单独的助词、助动词、接尾辞，也不要产生“名词+助词”后立刻切开的生硬边界。
5. 可以有 8 到 30 字的字幕；自然短语超过 14 字时保留完整，不得为了 14 字拆开。
6. 同时覆盖这些现象：连续名词、复合词、形式名词、动词活用、引用、转折、原因、条件、结论；不要重复固定示例词。
7. 只输出 JSON 数组，不要 Markdown，不要解释。每个元素格式为 {{"text":"原文","segments":["字幕1","字幕2"]}}。

这是第 {batch} 批，必须使用与其他批次不同的词汇和句法。
""".strip()
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.9,
            "max_tokens": 6000,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    response = urlopen(
        Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        ),
        timeout=180,
    )
    payload = json.loads(response.read().decode("utf-8"))
    content = str(payload["choices"][0]["message"]["content"]).strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content).strip()
    result = json.loads(content)
    if not isinstance(result, list):
        raise ValueError("生成结果不是 JSON 数组。")
    return result


def validate_example(item: object) -> dict[str, object]:
    if not isinstance(item, dict):
        raise ValueError("样本不是对象。")
    text = item.get("text")
    segments = item.get("segments")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("样本文本为空。")
    if not isinstance(segments, list) or not segments or not all(isinstance(x, str) and x for x in segments):
        raise ValueError("样本分段为空或包含空字幕。")
    if "".join(segments) != text:
        raise ValueError("分段拼接结果与原文不一致。")
    return {"text": text, "segments": segments}


def existing_examples() -> list[dict[str, object]]:
    examples: list[dict[str, object]] = []
    for path in sorted(SOURCE_DIR.glob("*.txt")):
        lines = [line.strip() for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
        if lines:
            examples.append({"text": "".join(lines), "segments": lines})
    return examples


def main() -> None:
    env = load_env()
    api_key = env.get("SILICONFLOW_API")
    model = env.get("SILICONFLOW_MODEL")
    url = env.get("SILICONFLOW_BASEURL")
    if not api_key or not model or not url:
        raise RuntimeError(".env 缺少 SILICONFLOW_API、SILICONFLOW_MODEL 或 SILICONFLOW_BASEURL。")

    examples = existing_examples()
    failures: list[str] = []
    for index, category in enumerate(CATEGORIES, 1):
        for attempt in range(1, 4):
            try:
                generated = request_generation(api_key, model, url, category, index)
                accepted = 0
                for item in generated:
                    try:
                        examples.append(validate_example(item))
                        accepted += 1
                    except (TypeError, ValueError, json.JSONDecodeError) as error:
                        failures.append(f"batch={index}, item={item!r}, error={error}")
                if accepted:
                    print(f"batch {index}/{len(CATEGORIES)} accepted {accepted}")
                    break
            except Exception as error:
                if attempt == 3:
                    failures.append(f"batch={index}, request_error={error}")
                else:
                    time.sleep(2 * attempt)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as file:
        for example in examples:
            file.write(json.dumps(example, ensure_ascii=False) + "\n")
    print(f"saved={OUTPUT}")
    print(f"examples={len(examples)}")
    print(f"rejected={len(failures)}")
    if failures:
        (OUTPUT.with_suffix(".rejects.log")).write_text("\n".join(failures), encoding="utf-8")


if __name__ == "__main__":
    main()
