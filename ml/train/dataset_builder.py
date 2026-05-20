#!/usr/bin/env python3
"""Builds a training dataset from canonical 5s space-weather feed JSON.

Input format:
{
  "points": [
    {
      "timestamp": "...",
      "solarWind": {"speed": ..., "density": ...},
      "magneticField": {"x": ..., "y": ..., "z": ..., "bt": ...},
      "electricField": {"ey": ...},
      "coupling": {"newell": ..., "epsilon": ...},
      "indices": {"kp": ..., "dst": ...}
    }
  ]
}
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import List


@dataclass
class WindowExample:
  x: List[List[float]]
  y: List[float]
  timestamp: str


def feature_vector(point: dict) -> List[float]:
  sw = point.get("solarWind", {})
  b = point.get("magneticField", {})
  e = point.get("electricField", {})
  c = point.get("coupling", {})
  i = point.get("indices", {})
  return [
    float(sw.get("speed", 0.0)),
    float(sw.get("density", 0.0)),
    float(b.get("x", 0.0)),
    float(b.get("y", 0.0)),
    float(b.get("z", 0.0)),
    float(b.get("bt", 0.0)),
    float(e.get("ey", 0.0)),
    float(c.get("newell", 0.0)),
    float(c.get("epsilon", 0.0)),
    float(i.get("kp", 0.0)),
    float(i.get("dst", 0.0)),
  ]


def target_vector(point: dict) -> List[float]:
  i = point.get("indices", {})
  kp = float(i.get("kp", 0.0))
  dst = float(i.get("dst", 0.0))
  # Placeholder targets: perturbation and auroral intensity.
  perturb = max(0.0, kp * 10.0 - dst * 0.1)
  aurora = min(1.0, max(0.0, kp / 9.0 + max(0.0, -dst) / 400.0))
  return [perturb, aurora]


def build_examples(points: List[dict], input_steps: int, horizon_steps: int) -> List[WindowExample]:
  examples: List[WindowExample] = []
  for end in range(input_steps, len(points) - horizon_steps):
    context = points[end - input_steps : end]
    future = points[end + horizon_steps - 1]
    x = [feature_vector(item) for item in context]
    y = target_vector(future)
    examples.append(WindowExample(x=x, y=y, timestamp=future.get("timestamp", "")))
  return examples


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--input", required=True, help="Path to JSON feed input")
  parser.add_argument("--output", required=True, help="Path to dataset JSONL output")
  parser.add_argument("--input-steps", type=int, default=24, help="Input timesteps")
  parser.add_argument("--horizon-steps", type=int, default=12, help="Forecast timesteps")
  args = parser.parse_args()

  payload = json.loads(Path(args.input).read_text())
  points = payload.get("points", [])

  examples = build_examples(points, args.input_steps, args.horizon_steps)

  output_path = Path(args.output)
  output_path.parent.mkdir(parents=True, exist_ok=True)
  with output_path.open("w", encoding="utf-8") as f:
    for ex in examples:
      f.write(json.dumps({"x": ex.x, "y": ex.y, "timestamp": ex.timestamp}) + "\n")

  print(f"Wrote {len(examples)} examples to {output_path}")


if __name__ == "__main__":
  main()
