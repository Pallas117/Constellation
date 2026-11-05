#!/usr/bin/env python3
"""Nightly learning run for the always-on Gauss install (GAU-113, GAU-127).

Retrains the Kp 3 h forecaster (ml/train/train_kp.py) on NASA OMNI2 history and records the new
*candidate* with its held-out metrics and promotion-gate result in ml/models/registry.json.
It never promotes: GAU-38 forbids automatic production model promotion. Review the gate, then run
`python3 ml/train/train_kp.py --promote FILE`.

Skips itself while `gauss-services.sh balance` has paused learning to save battery
(~/Library/Application Support/Gauss/learning-paused).

The --telemetry argument is kept for the existing LaunchAgent; the live buffer is only counted,
so the log shows how much live data has accumulated for future fine-tuning. Counting is
incremental (GAU-156): only bytes appended since the last run are read, from a byte offset kept in
ml/data/nightly/telemetry-count.json (counts and offsets only; the telemetry is never modified).
Training is skipped when the same data, code and libraries were already trained (status
"unchanged"), since the run is deterministic.
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


COUNT_STATE = HERE.parent / "data" / "nightly" / "telemetry-count.json"
CHUNK = 1 << 20  # read 1 MiB at a time: memory stays flat however large the buffer grows
MARKERS = (b'"type":"canonical"', b'"type": "canonical"')


def count_canonical(telemetry: Path, state_path: Path = COUNT_STATE) -> int:
  """Live canonical points buffered so far, reading only what was appended since the last count.

  Only complete lines are counted; a partly written last line is picked up next time. If the file
  shrank or was replaced (rotation), it is recounted from the start.
  """
  if not telemetry.exists():
    return 0
  st = telemetry.stat()
  try:
    prev = json.loads(state_path.read_text())
  except Exception:  # noqa: BLE001
    prev = {}
  same_file = prev.get("inode") == st.st_ino and prev.get("offset", 0) <= st.st_size
  offset, count = (prev["offset"], prev["count"]) if same_file else (0, 0)
  with telemetry.open("rb") as f:
    f.seek(offset)
    tail = b""
    while True:
      chunk = f.read(CHUNK)
      if not chunk:
        break
      lines = (tail + chunk).split(b"\n")
      tail = lines.pop()  # incomplete (or empty) last piece
      count += sum(1 for line in lines if any(m in line for m in MARKERS))
      offset += len(chunk)
  offset -= len(tail)  # resume at the start of the incomplete line
  state_path.parent.mkdir(parents=True, exist_ok=True)
  state_path.write_text(json.dumps({"inode": st.st_ino, "offset": offset, "count": count}) + "\n")
  return count


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--telemetry", default="data/bedrock/telemetry.jsonl")
  args = parser.parse_args()

  log = {"run": datetime.now(tz=timezone.utc).isoformat(), "live_points": count_canonical(Path(args.telemetry))}
  if PAUSE_FLAG.exists():
    log.update(status="paused", reason="battery saving (gauss-services.sh balance)")
    print(json.dumps(log))
    return 0

  result = subprocess.run([sys.executable, "-I", str(HERE / "train_kp.py"), "--skip-if-unchanged"],
                          capture_output=True, text=True)
  if result.returncode != 0:
    log.update(status="failed", error=result.stderr.strip()[-500:])
    print(json.dumps(log))
    return 1
  out = json.loads(result.stdout)
  log.update(
    status="unchanged" if out.get("unchanged") else "ok",
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
