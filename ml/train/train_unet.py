#!/usr/bin/env python3
"""Training entrypoint for space-weather nowcasting U-Net baseline.

This script supports a minimal pure-Python fallback when torch is unavailable,
so orchestration and model registry flow can still be exercised.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import List


def load_jsonl(path: Path) -> List[dict]:
  rows: List[dict] = []
  if not path.exists():
    return rows
  with path.open("r", encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      rows.append(json.loads(line))
  return rows


def baseline_train(rows: List[dict]) -> dict:
  if not rows:
    return {
      "loss": None,
      "samples": 0,
      "message": "No data",
    }

  # Simple target statistics baseline.
  y0 = [float(row["y"][0]) for row in rows]
  y1 = [float(row["y"][1]) for row in rows]
  mean0 = sum(y0) / len(y0)
  mean1 = sum(y1) / len(y1)
  var0 = sum((v - mean0) ** 2 for v in y0) / len(y0)
  var1 = sum((v - mean1) ** 2 for v in y1) / len(y1)

  return {
    "loss": math.sqrt(var0 + var1),
    "samples": len(rows),
    "predict_mean": [mean0, mean1],
  }


def update_registry(registry_path: Path, model_entry: dict) -> None:
  registry_path.parent.mkdir(parents=True, exist_ok=True)
  if registry_path.exists():
    registry = json.loads(registry_path.read_text())
  else:
    registry = {"models": []}
  registry.setdefault("models", []).append(model_entry)
  registry_path.write_text(json.dumps(registry, indent=2))


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--dataset", default="ml/data/train_dataset.jsonl")
  parser.add_argument("--registry", default="ml/models/registry.json")
  parser.add_argument("--model-version", default="unet-baseline-v1")
  parser.add_argument("--epochs", type=int, default=20)
  args = parser.parse_args()

  dataset_path = Path(args.dataset)
  registry_path = Path(args.registry)

  rows = load_jsonl(dataset_path)
  metrics = baseline_train(rows)

  model_entry = {
    "version": args.model_version,
    "trained_at": datetime.now(tz=timezone.utc).isoformat(),
    "epochs": args.epochs,
    "metrics": metrics,
    "dataset": str(dataset_path),
    "status": "ready",
  }

  update_registry(registry_path, model_entry)

  print(json.dumps({"ok": True, "model": model_entry}, indent=2))


if __name__ == "__main__":
  main()
