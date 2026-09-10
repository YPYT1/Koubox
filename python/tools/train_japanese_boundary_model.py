from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import torch
from torch import Tensor

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python" / "src"))

from koubox_runtime.japanese_boundary_model import (  # noqa: E402
    JapaneseBoundaryScorer,
    boundary_example,
)
from koubox_runtime.japanese_tokenizer import (  # noqa: E402
    JapaneseSplitMode,
    tokenize_japanese,
)

DATASET = ROOT / "training-data" / "japanese_boundary_examples.jsonl"
MODEL_PATH = ROOT / "models" / "japanese_subtitle_boundary.pt"
METRICS_PATH = ROOT / "models" / "japanese_subtitle_boundary.metrics.json"
SEED = 20260909


def require_cuda() -> torch.device:
    if not torch.cuda.is_available():
        raise RuntimeError("日文字幕边界模型训练必须使用 NVIDIA CUDA GPU。")
    device = torch.device("cuda:0")
    torch.cuda.set_device(device)
    return device


def load_documents() -> list[dict[str, object]]:
    documents = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(documents) < 30:
        raise RuntimeError(f"有效训练文档不足：{len(documents)}，至少需要 30。")
    return documents


def document_examples(document: dict[str, object]) -> tuple[list[list[int]], list[list[float]], list[int]]:
    text = str(document["text"])
    segments = [str(segment) for segment in document["segments"]]
    if "".join(segments) != text:
        raise ValueError("训练文档的分段无法还原原文。")
    positive_positions: set[int] = set()
    cursor = 0
    for segment in segments[:-1]:
        cursor += len(segment)
        positive_positions.add(cursor)

    morphemes = tokenize_japanese(text, JapaneseSplitMode.C)
    candidate_positions = {
        morpheme.end
        for morpheme in morphemes
        if 0 < morpheme.end < len(text)
    }
    candidate_positions.update(positive_positions)
    character_ids: list[list[int]] = []
    features: list[list[float]] = []
    labels: list[int] = []
    for position in sorted(candidate_positions):
        ids, numeric = boundary_example(text, position, 0, len(text), morphemes)
        character_ids.append(ids)
        features.append(numeric)
        labels.append(1 if position in positive_positions else 0)
    return character_ids, features, labels


def tensors(documents: list[dict[str, object]], device: torch.device) -> tuple[Tensor, Tensor, Tensor]:
    all_ids: list[list[int]] = []
    all_features: list[list[float]] = []
    all_labels: list[int] = []
    for document in documents:
        ids, features, labels = document_examples(document)
        all_ids.extend(ids)
        all_features.extend(features)
        all_labels.extend(labels)
    return (
        torch.tensor(all_ids, dtype=torch.long, device=device),
        torch.tensor(all_features, dtype=torch.float32, device=device),
        torch.tensor(all_labels, dtype=torch.long, device=device),
    )


def metrics(logits: Tensor, labels: Tensor) -> dict[str, float]:
    predicted = logits.argmax(dim=1)
    true_positive = int(((predicted == 1) & (labels == 1)).sum().item())
    false_positive = int(((predicted == 1) & (labels == 0)).sum().item())
    false_negative = int(((predicted == 0) & (labels == 1)).sum().item())
    correct = int((predicted == labels).sum().item())
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    return {
        "accuracy": correct / len(labels),
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / max(1e-9, precision + recall),
    }


def main() -> None:
    random.seed(SEED)
    torch.manual_seed(SEED)
    device = require_cuda()
    documents = load_documents()
    source_documents = documents[:10]
    generated_documents = documents[10:]
    random.shuffle(generated_documents)
    validation_count = max(10, len(generated_documents) // 5)
    validation_documents = generated_documents[:validation_count]
    training_documents = generated_documents[validation_count:]
    train_ids, train_features, train_labels = tensors(training_documents, device)
    validation_ids, validation_features, validation_labels = tensors(validation_documents, device)

    model = JapaneseBoundaryScorer().to(device)
    class_counts = torch.bincount(train_labels, minlength=2).float()
    class_weights = class_counts.sum() / class_counts.clamp_min(1)
    criterion = torch.nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=0.01)
    scaler = torch.amp.GradScaler("cuda")
    batch_size = 512
    best_f1 = -1.0
    best_state: dict[str, Tensor] | None = None
    torch.cuda.reset_peak_memory_stats(device)

    for epoch in range(1, 31):
        model.train()
        permutation = torch.randperm(len(train_labels), device=device)
        for start in range(0, len(permutation), batch_size):
            selected = permutation[start : start + batch_size]
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", dtype=torch.float16):
                logits = model(train_ids[selected], train_features[selected])
                loss = criterion(logits, train_labels[selected])
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

        model.eval()
        with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.float16):
            validation_logits = model(validation_ids, validation_features)
        current = metrics(validation_logits.float(), validation_labels)
        print(f"epoch={epoch:02d} loss={loss.item():.4f} validation_f1={current['f1']:.4f}")
        if current["f1"] > best_f1:
            best_f1 = current["f1"]
            best_state = {name: value.detach().cpu() for name, value in model.state_dict().items()}

    if best_state is None:
        raise RuntimeError("训练没有产生有效模型。")
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "format_version": 1,
            "model": best_state,
            "seed": SEED,
            "training_documents": len(training_documents),
            "validation_documents": len(validation_documents),
        },
        MODEL_PATH,
    )
    peak_allocated = torch.cuda.max_memory_allocated(device)
    peak_reserved = torch.cuda.max_memory_reserved(device)
    result = {
        "device": torch.cuda.get_device_name(device),
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
        "model_bytes": MODEL_PATH.stat().st_size,
        "training_documents": len(training_documents),
        "validation_documents": len(validation_documents),
        "training_boundaries": len(train_labels),
        "validation_boundaries": len(validation_labels),
        "validation": metrics(validation_logits.float(), validation_labels),
        "peak_cuda_allocated_bytes": peak_allocated,
        "peak_cuda_reserved_bytes": peak_reserved,
        "under_one_gib_vram": peak_reserved < 1024**3,
    }
    METRICS_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["under_one_gib_vram"]:
        raise RuntimeError("训练峰值 CUDA 显存超过 1 GiB。")


if __name__ == "__main__":
    main()
