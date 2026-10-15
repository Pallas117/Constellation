#!/usr/bin/env python3
"""Nightly learning run for the always-on Gauss install (GAU-113, GAU-126).

Retrains the Kp 3 h forecaster (ml/train/train_kp.py) on NASA OMNI2 history and records the new
*candidate* with its held-out metrics and promotion-gate result in ml/models/registry.json.
It never promotes: GAU-38 forbids automatic production model promotion. Review the gate, then run
`python3 ml/train/train_kp.py --promote FILE`.

Skips itself while `gauss-services.sh balance` has paused learning to save battery
(~/Library/Application Support/Gauss/learning-paused).

The --telemetry argument is kept for the existing LaunchAgent; the live buffer is only counted,
so the log shows how much live data has accumulated for future fine-tuning.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAUSE_FLAG = Path.home() / "Library" / "Application Support" / "Gauss" / "learning-paused"


def count_canonical(telemetry: Path) -> int:
  """Live canonical points buffered so far (unreadable lines skipped)."""
  if not telemetry.exists():
    return 0
  n = 0
  with telemetry.open("r", encoding="utf-8") as f:
    for line in f:
      if '"type":"canonical"' in line or '"type": "canonical"' in line:
        n += 1
  return n


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--telemetry", default="data/bedrock/telemetry.jsonl")
  args = parser.parse_args()

  log = {"run": datetime.now(tz=timezone.utc).isoformat(), "live_points": count_canonical(Path(args.telemetry))}
  if PAUSE_FLAG.exists():
    log.update(status="paused", reason="battery saving (gauss-services.sh balance)")
    print(json.dumps(log))
    return 0

  result = subprocess.run([sys.executable, "-I", str(HERE / "train_kp.py")], capture_output=True, text=True)
  if result.returncode != 0:
    log.update(status="failed", error=result.stderr.strip()[-500:])
    print(json.dumps(log))
    return 1
  out = json.loads(result.stdout)
  log.update(
    status="ok",
    candidate=out["version"],
    gate_passed=out["gate"]["passed"],
    test_mae=out["test"]["mae"],
    test_mae_persistence=out["test"]["mae_persistence"],
    note="candidate only; promote deliberately with train_kp.py --promote",
  )
  print(json.dumps(log))
  return 0


if __name__ == "__main__":
  sys.exit(main())
