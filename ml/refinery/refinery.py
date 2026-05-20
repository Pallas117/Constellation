#!/usr/bin/env python3
"""
Data Refinery — Stage 1: Schema validation, Stage 2: Isolation Forest,
Stage 3: Rolling IQR filter.

Reads canonical telemetry JSON, classifies each point as:
  clean       → written to --output JSONL for training
  quarantined → archived in --quarantine JSONL (never deleted)
  interpolated → IQR soft-fails replaced with linear interpolation

Usage:
  python3 ml/refinery/refinery.py \\
      --input ml/data/raw_feed.json \\
      --output ml/data/clean_feed.json \\
      --quarantine ml/data/quarantine.jsonl \\
      --report ml/data/refinery_report.json
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─── Physical plausibility bounds (heliophysics) ─────────────────────────────

FIELD_BOUNDS: dict[str, tuple[float, float]] = {
    "solarWind.speed":    (200.0, 2500.0),
    "solarWind.density":  (0.01,  100.0),
    "magneticField.z":    (-200.0, 200.0),
    "magneticField.bt":   (0.0,   300.0),
    "indices.kp":         (0.0,   9.0),
    "indices.dst":        (-600.0, 100.0),
    "coupling.newell":    (0.0,   1e7),
}

IQR_WINDOW = 60          # rolling window for IQR computation
IQR_MULTIPLIER = 3.0     # points beyond 3×IQR are interpolation candidates
ISOLATION_CONTAMINATION = 0.05  # expect ~5% anomalies in raw telemetry


# ─── Utility ─────────────────────────────────────────────────────────────────

def _get(point: dict, dotpath: str) -> float | None:
    parts = dotpath.split(".")
    obj: Any = point
    for p in parts:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(p)
    if obj is None:
        return None
    try:
        return float(obj)
    except (TypeError, ValueError):
        return None


def _set(point: dict, dotpath: str, value: float) -> dict:
    parts = dotpath.split(".")
    obj = point
    for p in parts[:-1]:
        obj = obj.setdefault(p, {})
    obj[parts[-1]] = value
    return point


# ─── Stage 1: Schema validation ──────────────────────────────────────────────

REQUIRED_PATHS = [
    "timestamp",
    "solarWind.speed",
    "solarWind.density",
    "magneticField.z",
    "magneticField.bt",
    "indices.kp",
    "indices.dst",
]


def validate_schema(point: dict) -> list[str]:
    """Return list of validation failures (empty = pass)."""
    failures: list[str] = []

    # Required fields
    for path in REQUIRED_PATHS:
        val = _get(point, path)
        if path == "timestamp":
            if not isinstance(point.get("timestamp"), str):
                failures.append(f"missing:{path}")
        elif val is None or not math.isfinite(val):
            failures.append(f"missing_or_nan:{path}")

    # Physical plausibility
    for field, (lo, hi) in FIELD_BOUNDS.items():
        val = _get(point, field)
        if val is not None and (val < lo or val > hi):
            failures.append(f"out_of_bounds:{field}={val:.3f} [{lo},{hi}]")

    return failures


# ─── Stage 2: Isolation Forest (pure-Python, no scikit) ──────────────────────

class PureIsolationForest:
    """
    Lightweight Isolation Forest without scikit-learn dependency.
    Uses random binary splits; anomaly score = mean path length < expected.
    """
    def __init__(self, n_trees: int = 50, sample_size: int = 256, seed: int = 42):
        self.n_trees = n_trees
        self.sample_size = sample_size
        self._rng_state = seed
        self._trees: list[dict] = []
        self._fitted = False

    def _rng(self) -> float:
        # xorshift32
        x = self._rng_state
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self._rng_state = x & 0xFFFFFFFF
        return x / 0xFFFFFFFF

    def _build_tree(self, data: list[list[float]], depth: int, max_depth: int) -> dict:
        n = len(data)
        if n <= 1 or depth >= max_depth:
            return {"leaf": True, "size": n}
        dim = len(data[0])
        feat = int(self._rng() * dim)
        vals = [row[feat] for row in data]
        lo, hi = min(vals), max(vals)
        if lo == hi:
            return {"leaf": True, "size": n}
        split = lo + self._rng() * (hi - lo)
        left = [row for row in data if row[feat] < split]
        right = [row for row in data if row[feat] >= split]
        return {
            "leaf": False,
            "feat": feat,
            "split": split,
            "left": self._build_tree(left, depth + 1, max_depth),
            "right": self._build_tree(right, depth + 1, max_depth),
        }

    def _path_length(self, node: dict, x: list[float], depth: int) -> float:
        if node.get("leaf"):
            n = node["size"]
            if n <= 1:
                return depth
            c = 2.0 * (math.log(n - 1) + 0.5772156649) - 2.0 * (n - 1) / n
            return depth + c
        if x[node["feat"]] < node["split"]:
            return self._path_length(node["left"], x, depth + 1)
        return self._path_length(node["right"], x, depth + 1)

    def fit(self, X: list[list[float]]) -> None:
        n = len(X)
        max_depth = int(math.ceil(math.log2(min(self.sample_size, n) or 2)))
        self._trees = []
        for _ in range(self.n_trees):
            idxs = [int(self._rng() * n) for _ in range(min(self.sample_size, n))]
            sample = [X[i] for i in idxs]
            self._trees.append(self._build_tree(sample, 0, max_depth))
        self._fitted = True

    def score(self, x: list[float]) -> float:
        """Return anomaly score in [0,1]. Higher = more anomalous."""
        if not self._fitted or not self._trees:
            return 0.0
        mean_path = statistics.mean(self._path_length(t, x, 0) for t in self._trees)
        n = self.sample_size
        c = 2.0 * (math.log(n - 1) + 0.5772156649) - 2.0 * (n - 1) / n if n > 1 else 1.0
        return 2 ** (-mean_path / c)


FEATURE_PATHS = [
    "solarWind.speed",
    "solarWind.density",
    "magneticField.z",
    "magneticField.bt",
    "electricField.ey",
    "coupling.newell",
    "coupling.epsilon",
    "indices.kp",
    "indices.dst",
]


def to_feature_vector(point: dict) -> list[float]:
    return [float(_get(point, p) or 0.0) for p in FEATURE_PATHS]


# ─── Stage 3: Rolling IQR interpolation ──────────────────────────────────────

def rolling_iqr_check(points: list[dict], window: int = IQR_WINDOW) -> list[dict]:
    """
    For each numeric field, compute rolling median / IQR.
    Points outside IQR_MULTIPLIER × IQR are soft-flagged and linearly
    interpolated from their neighbours.
    """
    for field in FEATURE_PATHS:
        values = [_get(p, field) for p in points]
        for i in range(len(points)):
            lo = max(0, i - window // 2)
            hi = min(len(values), i + window // 2 + 1)
            window_vals = [v for v in values[lo:hi] if v is not None]
            if len(window_vals) < 4:
                continue
            window_vals.sort()
            n = len(window_vals)
            q1 = window_vals[n // 4]
            q3 = window_vals[3 * n // 4]
            iqr = q3 - q1
            if iqr == 0:
                continue
            val = values[i]
            if val is None:
                continue
            if val < q1 - IQR_MULTIPLIER * iqr or val > q3 + IQR_MULTIPLIER * iqr:
                # Linear interpolation between neighbours
                prev_val = next((values[j] for j in range(i - 1, -1, -1) if values[j] is not None), val)
                next_val = next((values[j] for j in range(i + 1, len(values)) if values[j] is not None), val)
                interpolated = (prev_val + next_val) / 2.0
                _set(points[i], field, interpolated)
                points[i]["_iqr_interpolated"] = points[i].get("_iqr_interpolated", [])
                points[i]["_iqr_interpolated"].append(field)  # type: ignore[attr-defined]
    return points


# ─── Main Pipeline ────────────────────────────────────────────────────────────

def run_refinery(
    points: list[dict],
    dry_run: bool = False,
) -> tuple[list[dict], list[dict], dict]:
    """
    Returns: (clean_points, quarantined_points, report_dict)
    """
    clean: list[dict] = []
    quarantined: list[dict] = []
    schema_failures = 0
    isolation_failures = 0
    iqr_interpolations = 0

    # Stage 2 training
    iforest = PureIsolationForest()
    if len(points) >= 50:
        X = [to_feature_vector(p) for p in points]
        iforest.fit(X)

    # Stage 1 + 2 pass
    for point in points:
        failures = validate_schema(point)
        if failures:
            schema_failures += 1
            point["_quarantine_reason"] = f"schema:{failures[0]}"
            quarantined.append(point)
            continue

        if len(points) >= 50:
            score = iforest.score(to_feature_vector(point))
            if score > (1.0 - ISOLATION_CONTAMINATION):
                isolation_failures += 1
                point["_quarantine_reason"] = f"isolation_forest:score={score:.3f}"
                quarantined.append(point)
                continue

        clean.append(point)

    # Stage 3: rolling IQR on clean points
    if not dry_run:
        clean = rolling_iqr_check(clean)
        iqr_interpolations = sum(
            1 for p in clean if "_iqr_interpolated" in p
        )

    report = {
        "run_at": datetime.now(tz=timezone.utc).isoformat(),
        "total_input": len(points),
        "clean": len(clean),
        "quarantined": len(quarantined),
        "schema_failures": schema_failures,
        "isolation_forest_failures": isolation_failures,
        "iqr_interpolations": iqr_interpolations,
        "quality_rate": len(clean) / max(1, len(points)),
    }
    return clean, quarantined, report


def main() -> None:
    parser = argparse.ArgumentParser(description="Gauss Aurora Data Refinery")
    parser.add_argument("--input", required=True, help="Raw feed JSON (with 'points' array)")
    parser.add_argument("--output", required=True, help="Clean feed JSON output")
    parser.add_argument("--quarantine", default="ml/data/quarantine.jsonl", help="Quarantine JSONL archive")
    parser.add_argument("--report", default="ml/data/refinery_report.json", help="Quality report JSON")
    parser.add_argument("--dry-run", action="store_true", help="Validate only, no file writes")
    args = parser.parse_args()

    input_path = Path(args.input)
    payload = json.loads(input_path.read_text())
    points = payload.get("points", [])

    print(f"[Refinery] Processing {len(points)} points from {input_path}")

    clean, quarantined, report = run_refinery(points, dry_run=args.dry_run)

    if not args.dry_run:
        Path(args.output).write_text(json.dumps({"points": clean}, indent=2))
        q_path = Path(args.quarantine)
        q_path.parent.mkdir(parents=True, exist_ok=True)
        with q_path.open("a", encoding="utf-8") as f:
            for q in quarantined:
                f.write(json.dumps(q) + "\n")
        Path(args.report).write_text(json.dumps(report, indent=2))

    print(json.dumps(report, indent=2))
    print(f"[Refinery] Done — {report['clean']} clean, {report['quarantined']} quarantined, "
          f"quality={report['quality_rate']:.1%}")


if __name__ == "__main__":
    main()
