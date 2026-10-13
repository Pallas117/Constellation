"""Kp 3-hour-ahead forecaster: feature definition and numpy inference (GAU-113).

Shared by training (ml/train/train_kp.py) and serving (ml/infer/infer_server.py) so the
two can never disagree about what a feature means. Weights are stored as plain JSON
(no pickle), and inference needs only numpy.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

HORIZON_HOURS = 3
WINDOW_HOURS = 6
STORM_KP = 4.65  # Kp 5- and above: SWPC counts 5-, 5 and 5+ as G1 (OMNI codes 5- as 47)
# Per-hour drivers, in this order, for each of the last WINDOW_HOURS hours (oldest first).
HOURLY_FEATURES = ("bz_gsm", "by_gsm", "speed", "density", "pressure", "newell")
FEATURE_NAMES: List[str] = [
  f"{name}_t-{lag}" for lag in range(WINDOW_HOURS - 1, -1, -1) for name in HOURLY_FEATURES
] + ["kp_now"]

MODELS_DIR = Path(__file__).resolve().parent / "models"
PROMOTED_POINTER = MODELS_DIR / "promoted.json"


def newell_coupling(speed: float, by: float, bz: float) -> float:
  """Newell et al. (2007) dPhi_MP/dt = v^(4/3) * Bt^(2/3) * sin^(8/3)(theta/2), in kV-ish units / 1e3."""
  if any(math.isnan(x) for x in (speed, by, bz)):
    return math.nan
  bt = math.hypot(by, bz)
  theta = math.atan2(by, bz)
  return (abs(speed) ** (4 / 3)) * (bt ** (2 / 3)) * (abs(math.sin(theta / 2)) ** (8 / 3)) / 1e3


def hourly_row(bz: float, by: float, speed: float, density: float, pressure: float) -> List[float]:
  return [bz, by, speed, density, pressure, newell_coupling(speed, by, bz)]


def feature_vector(hours: Sequence[Sequence[float]], kp_now: float) -> Optional[np.ndarray]:
  """WINDOW_HOURS hourly rows (oldest first) + current Kp -> features, or None if any is missing."""
  if len(hours) != WINDOW_HOURS:
    return None
  flat = [v for row in hours for v in row] + [kp_now]
  arr = np.asarray(flat, dtype=np.float64)
  return arr if np.all(np.isfinite(arr)) else None


class KpForecaster:
  """Ensemble of small MLPs with a Kp regression head and a storm-probability head."""

  def __init__(self, spec: Dict[str, Any]):
    if spec.get("feature_names") != FEATURE_NAMES:
      raise ValueError("model feature set does not match this code")
    self.version: str = spec["version"]
    self.mean = np.asarray(spec["scaler"]["mean"], dtype=np.float64)
    self.std = np.asarray(spec["scaler"]["std"], dtype=np.float64)
    self.members = [
      {k: np.asarray(v, dtype=np.float64) for k, v in member.items()} for member in spec["members"]
    ]
    self.metrics: Dict[str, Any] = spec.get("metrics", {})

  @staticmethod
  def load(path: Path) -> "KpForecaster":
    return KpForecaster(json.loads(path.read_text()))

  @staticmethod
  def load_promoted() -> Optional["KpForecaster"]:
    """The promoted model, or None when nothing has passed the promotion gate."""
    if not PROMOTED_POINTER.exists():
      return None
    pointer = json.loads(PROMOTED_POINTER.read_text())
    path = MODELS_DIR / pointer["file"]
    if not path.exists():
      # A promotion that points at a missing file is a broken deployment, not "no model". GAU-121.
      raise FileNotFoundError(f"promoted model file missing: {pointer['file']}")
    return KpForecaster.load(path)

  def _member(self, m: Dict[str, np.ndarray], x: np.ndarray):
    h = np.maximum(0.0, x @ m["w1"] + m["b1"])
    h = np.maximum(0.0, h @ m["w2"] + m["b2"])
    kp = h @ m["w_kp"] + m["b_kp"]
    logit = h @ m["w_storm"] + m["b_storm"]
    return kp[..., 0], 1.0 / (1.0 + np.exp(-logit[..., 0]))

  def predict(self, features: np.ndarray) -> Dict[str, Any]:
    """features: (n, len(FEATURE_NAMES)). Returns ensemble mean and member spread."""
    x = (np.atleast_2d(features) - self.mean) / self.std
    outs = [self._member(m, x) for m in self.members]
    kps = np.stack([o[0] for o in outs])
    probs = np.stack([o[1] for o in outs])
    return {
      "kp": np.clip(kps.mean(axis=0), 0.0, 9.0),
      "storm_probability": probs.mean(axis=0),
      "storm_probability_range": (probs.min(axis=0), probs.max(axis=0)),
    }
