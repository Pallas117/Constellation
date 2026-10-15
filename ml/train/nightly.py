#!/usr/bin/env python3
"""Nightly learning run for the always-on Gauss install.

Collects every canonical space-weather point the live service has buffered
(data/bedrock/telemetry.jsonl), rebuilds the windowed dataset with
dataset_builder, runs the training entrypoint, and records a dated model
version in ml/models/registry.json. Earlier versions stay in the registry, so
a run can be compared with or rolled back to any previous one.

Note: train_unet.py is currently a statistical baseline with placeholder
targets, not a trained neural network. This job keeps the pipeline exercised
on real, growing data so a real model can drop in later.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical_points(telemetry: Path) -> list[dict]:
    """Unique canonical points by timestamp, oldest first. Skips unreadable lines."""
    by_time: dict[str, dict] = {}
    if not telemetry.exists():
        return []
    with telemetry.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            point = row.get("data") if isinstance(row, dict) and row.get("type") == "canonical" else None
            if isinstance(point, dict) and isinstance(point.get("timestamp"), str):
                by_time[point["timestamp"]] = point
    return [by_time[t] for t in sorted(by_time)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--telemetry", default="data/bedrock/telemetry.jsonl")
    parser.add_argument("--work-dir", default="ml/data/nightly")
    parser.add_argument("--registry", default="ml/models/registry.json")
    parser.add_argument("--input-steps", type=int, default=24)
    parser.add_argument("--horizon-steps", type=int, default=12)
    args = parser.parse_args()

    started = datetime.now(tz=timezone.utc)
    points = canonical_points(Path(args.telemetry))
    needed = args.input_steps + args.horizon_steps
    log = {"run": started.isoformat(), "points": len(points)}
    if len(points) < needed:
        log.update(status="skipped", reason=f"need at least {needed} points, have {len(points)}")
        print(json.dumps(log))
        return 0

    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    feed = work / "feed.json"
    dataset = work / "train_dataset.jsonl"
    feed.write_text(json.dumps({"points": points}))

    version = f"nightly-{started:%Y%m%d-%H%M}"
    py = sys.executable
    subprocess.run(
        [py, "-I", str(HERE / "dataset_builder.py"), "--input", str(feed), "--output", str(dataset),
         "--input-steps", str(args.input_steps), "--horizon-steps", str(args.horizon_steps)],
        check=True,
    )
    result = subprocess.run(
        [py, "-I", str(HERE / "train_unet.py"), "--dataset", str(dataset), "--registry", args.registry, "--model-version", version],
        check=True, capture_output=True, text=True,
    )
    model = json.loads(result.stdout).get("model", {})
    log.update(status="ok", version=version, samples=model.get("metrics", {}).get("samples"), first=points[0]["timestamp"], last=points[-1]["timestamp"])
    print(json.dumps(log))
    return 0


if __name__ == "__main__":
    sys.exit(main())
