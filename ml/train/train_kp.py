#!/usr/bin/env python3
"""Train and evaluate the Kp 3-hour-ahead forecaster on NASA OMNI2 hourly data (GAU-113).

  python3 ml/train/train_kp.py              train + evaluate -> candidate in ml/models/
  python3 ml/train/train_kp.py --promote F  promote candidate file F, only if it passed the gate
  python3 ml/train/train_kp.py --skip-if-unchanged
                                            report the existing candidate instead of retraining when
                                            the data, training code and libraries are unchanged

Time-ordered splits (no shuffling across time): train 2010-2019, validate 2020-2021,
test 2022-2024. Training never promotes a model by itself (GAU-38 guardrail); promotion is
an explicit step that refuses a candidate that failed the gate.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Tuple

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(ML_DIR / "train"))

from kp_model import (  # noqa: E402
  FEATURE_NAMES,
  HORIZON_HOURS,
  MODELS_DIR,
  PROMOTED_POINTER,
  STORM_KP,
  WINDOW_HOURS,
  KpForecaster,
)
from omni import DATA_DIR, ensure_year, load_years, sha256  # noqa: E402

SPLITS: Dict[str, range] = {
  "train": range(2010, 2020),
  "val": range(2020, 2022),
  "test": range(2022, 2025),
}
SEEDS = (0, 1, 2, 3, 4)
GATE_MAE_IMPROVEMENT = 0.05  # must beat persistence MAE by at least 5%
REGISTRY = MODELS_DIR / "registry.json"


def newell_vec(speed: np.ndarray, by: np.ndarray, bz: np.ndarray) -> np.ndarray:
  bt = np.hypot(by, bz)
  theta = np.arctan2(by, bz)
  return (np.abs(speed) ** (4 / 3)) * (bt ** (2 / 3)) * (np.abs(np.sin(theta / 2)) ** (8 / 3)) / 1e3


def build_split(years: Iterable[int]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
  """Features (n, F), target Kp(t+3h) (n,), current Kp (n,) for complete windows only."""
  d = load_years(years)
  hourly = np.stack(
    [d["bz_gsm"], d["by_gsm"], d["speed"], d["density"], d["pressure"],
     newell_vec(d["speed"], d["by_gsm"], d["bz_gsm"])],
    axis=1,
  )
  n = hourly.shape[0]
  t = np.arange(WINDOW_HOURS - 1, n - HORIZON_HOURS)
  windows = np.stack([hourly[t - lag] for lag in range(WINDOW_HOURS - 1, -1, -1)], axis=1)
  x = np.concatenate([windows.reshape(len(t), -1), d["kp"][t, None]], axis=1)
  y = d["kp"][t + HORIZON_HOURS]
  ok = np.all(np.isfinite(x), axis=1) & np.isfinite(y)
  assert x.shape[1] == len(FEATURE_NAMES)
  return x[ok], y[ok], d["kp"][t][ok]


def train_member(seed: int, x_tr, y_tr, x_va, y_va) -> Dict[str, list]:
  import torch
  from torch import nn

  torch.manual_seed(seed)
  np.random.seed(seed)
  torch.use_deterministic_algorithms(True)
  torch.set_num_threads(2)

  class Net(nn.Module):
    def __init__(self, f: int):
      super().__init__()
      self.l1 = nn.Linear(f, 64)
      self.l2 = nn.Linear(64, 32)
      self.kp = nn.Linear(32, 1)
      self.storm = nn.Linear(32, 1)

    def forward(self, x):
      h = torch.relu(self.l2(torch.relu(self.l1(x))))
      return self.kp(h).squeeze(-1), self.storm(h).squeeze(-1)

  net = Net(x_tr.shape[1])
  opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
  huber = nn.HuberLoss()
  bce = nn.BCEWithLogitsLoss()  # unweighted, so the probabilities stay calibrated

  xt = torch.tensor(x_tr, dtype=torch.float32)
  yt = torch.tensor(y_tr, dtype=torch.float32)
  st = (yt >= STORM_KP).float()
  xv = torch.tensor(x_va, dtype=torch.float32)
  yv = torch.tensor(y_va, dtype=torch.float32)
  sv = (yv >= STORM_KP).float()

  gen = torch.Generator().manual_seed(seed)
  best, best_state, patience = float("inf"), None, 0
  for _epoch in range(80):
    net.train()
    for idx in torch.randperm(len(xt), generator=gen).split(512):
      kp, logit = net(xt[idx])
      loss = huber(kp, yt[idx]) + bce(logit, st[idx])
      opt.zero_grad()
      loss.backward()
      opt.step()
    net.eval()
    with torch.no_grad():
      kp, logit = net(xv)
      val = float(huber(kp, yv) + bce(logit, sv))
    if val < best - 1e-5:
      best, patience = val, 0
      best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
    else:
      patience += 1
      if patience >= 8:
        break
  net.load_state_dict(best_state)

  sd = {k: v.numpy().astype(np.float64) for k, v in net.state_dict().items()}
  return {
    "w1": sd["l1.weight"].T.tolist(), "b1": sd["l1.bias"].tolist(),
    "w2": sd["l2.weight"].T.tolist(), "b2": sd["l2.bias"].tolist(),
    "w_kp": sd["kp.weight"].T.tolist(), "b_kp": sd["kp.bias"].tolist(),
    "w_storm": sd["storm.weight"].T.tolist(), "b_storm": sd["storm.bias"].tolist(),
  }


def evaluate(model: KpForecaster, x, y, kp_now, climatology: float) -> Dict[str, float]:
  out = model.predict(x)
  kp_hat, p = out["kp"], out["storm_probability"]
  storm = (y >= STORM_KP).astype(float)
  mae = float(np.mean(np.abs(kp_hat - y)))
  mae_persist = float(np.mean(np.abs(kp_now - y)))
  brier = float(np.mean((p - storm) ** 2))
  brier_clim = float(np.mean((climatology - storm) ** 2))
  brier_persist = float(np.mean(((kp_now >= STORM_KP).astype(float) - storm) ** 2))
  warn = p >= 0.5
  hits = float(np.sum(warn & (storm == 1)))
  storm_hours = float(np.sum(storm))
  in_storm = storm == 1
  return {
    "samples": int(len(y)),
    "storm_hours": int(storm_hours),
    "mae": round(mae, 4),
    "mae_persistence": round(mae_persist, 4),
    "mae_improvement_vs_persistence": round(1 - mae / mae_persist, 4),
    "mae_during_storms": round(float(np.mean(np.abs(kp_hat[in_storm] - y[in_storm]))), 4) if storm_hours else None,
    "mae_persistence_during_storms": round(float(np.mean(np.abs(kp_now[in_storm] - y[in_storm]))), 4) if storm_hours else None,
    "brier": round(brier, 5),
    "brier_climatology": round(brier_clim, 5),
    "brier_persistence": round(brier_persist, 5),
    "brier_skill_vs_climatology": round(1 - brier / brier_clim, 4),
    "brier_skill_vs_persistence": round(1 - brier / brier_persist, 4),
    "storm_pod_at_p50": round(hits / storm_hours, 4) if storm_hours else None,
    "storm_far_at_p50": round(float(np.sum(warn & (storm == 0))) / max(1.0, float(np.sum(warn))), 4),
    "finite": bool(np.all(np.isfinite(kp_hat)) and np.all(np.isfinite(p))),
  }


def git_sha() -> str:
  try:
    return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ML_DIR, check=True).stdout.strip()
  except Exception:  # noqa: BLE001
    return "unknown"


# Training is deterministic (fixed seeds, fixed OMNI files), so the same inputs give the same
# candidate. The version only hashes the data; the fingerprint also covers the code and
# libraries, so a code or library change still retrains (GAU-156).
CODE_PATHS = ("ml/train", "ml/kp_model.py")


def code_identity() -> str:
  """Committed tree hashes of the training code, or "" (never skip) if unknown or edited."""
  try:
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True,
                         cwd=ML_DIR, check=True).stdout.strip()
    # Tracked edits only: Python's own __pycache__ files appear as untracked and must not count.
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no", "--", *CODE_PATHS], capture_output=True,
                           text=True, cwd=top, check=True).stdout.strip()
    if dirty:
      return ""
    trees = subprocess.run(["git", "rev-parse", *[f"HEAD:{p}" for p in CODE_PATHS]], capture_output=True,
                           text=True, cwd=top, check=True).stdout.split()
    return ",".join(trees)
  except Exception:  # noqa: BLE001
    return ""


def training_fingerprint(checksums: Dict[str, str], code: str) -> str:
  """Data checksums + training code + library versions; "" when the code identity is unknown."""
  if not code:
    return ""
  import hashlib
  import torch
  parts = ["".join(checksums[k] for k in sorted(checksums)), code, torch.__version__, np.__version__]
  return hashlib.sha256("|".join(parts).encode()).hexdigest()


def already_trained(registry: Dict, version: str, fingerprint: str):
  """The registry entry for this exact training, if its model file is still there."""
  if not fingerprint:
    return None
  for m in registry.get("models", []):
    if m.get("version") == version and m.get("fingerprint") == fingerprint and (MODELS_DIR / m.get("file", "")).is_file():
      return m
  return None


def load_registry() -> Dict:
  return json.loads(REGISTRY.read_text()) if REGISTRY.exists() else {"models": []}


def train(skip_if_unchanged: bool = False) -> None:
  years = [y for r in SPLITS.values() for y in r]
  checksums = {str(y): sha256(ensure_year(y)) for y in years}
  digest = __import__("hashlib").sha256("".join(checksums.values()).encode()).hexdigest()[:8]
  version = f"kp3h-mlp-v1-{digest}"
  fingerprint = training_fingerprint(checksums, code_identity())
  if skip_if_unchanged:
    done = already_trained(load_registry(), version, fingerprint)
    if done:
      print(json.dumps({"version": version, "unchanged": True, "gate": done["gate"],
                        "test": done["metrics"]["test"]}, indent=2))
      return
  data = {name: build_split(r) for name, r in SPLITS.items()}
  x_tr, y_tr, _ = data["train"]
  x_va, y_va, kp_va = data["val"]
  x_te, y_te, kp_te = data["test"]

  mean = x_tr.mean(axis=0)
  std = x_tr.std(axis=0)
  std[std == 0] = 1.0
  norm = lambda x: (x - mean) / std  # noqa: E731
  members = [train_member(s, norm(x_tr), y_tr, norm(x_va), y_va) for s in SEEDS]

  spec = {
    "version": version,
    "task": f"Kp {HORIZON_HOURS} h ahead and P(Kp >= {STORM_KP}) from {WINDOW_HOURS} h of L1 solar wind",
    "feature_names": FEATURE_NAMES,
    "scaler": {"mean": mean.tolist(), "std": std.tolist()},
    "members": members,
  }
  model = KpForecaster(spec)
  climatology = float(np.mean(y_tr >= STORM_KP))
  metrics = {
    "climatology_storm_rate": round(climatology, 5),
    "validation": evaluate(model, x_va, y_va, kp_va, climatology),
    "test": evaluate(model, x_te, y_te, kp_te, climatology),
  }
  t = metrics["test"]
  gate = {
    "mae_beats_persistence_by_5pct": t["mae_improvement_vs_persistence"] >= GATE_MAE_IMPROVEMENT,
    "brier_skill_vs_climatology_positive": t["brier_skill_vs_climatology"] > 0,
    "outputs_finite": t["finite"],
  }
  gate["passed"] = all(gate.values())
  # Reported, not blocking: a regressor pulls rare extremes toward the mean, so during storm
  # hours the Kp value can trail persistence even when the storm probability has real skill.
  if t["mae_during_storms"] is not None and t["mae_during_storms"] > t["mae_persistence_during_storms"]:
    gate["warnings"] = [
      f"During storm hours the Kp estimate is worse than persistence "
      f"(MAE {t['mae_during_storms']} vs {t['mae_persistence_during_storms']}); "
      "use the storm probability, not the Kp value, for storm warnings."
    ]
  spec.update({
    "metrics": metrics,
    "gate": gate,
    "data": {
      "source": "NASA OMNI2 hourly (spdf.gsfc.nasa.gov low_res_omni)",
      "splits": {k: [r.start, r.stop - 1] for k, r in SPLITS.items()},
      "sha256": checksums,
      "samples": {k: int(len(v[1])) for k, v in data.items()},
    },
    "training": {
      "seeds": list(SEEDS),
      "architecture": f"MLP {len(FEATURE_NAMES)}-64-32, heads: Kp (Huber) + storm (BCE)",
      "optimizer": "AdamW lr 1e-3 wd 1e-4, batch 512, early stop on validation (patience 8)",
      "trained_at": datetime.now(tz=timezone.utc).isoformat(),
      "git_sha": git_sha(),
      "torch": __import__("torch").__version__,
    },
  })

  MODELS_DIR.mkdir(parents=True, exist_ok=True)
  out = MODELS_DIR / f"{version}.json"
  out.write_text(json.dumps(spec, separators=(",", ":")))
  registry = load_registry()
  for m in registry["models"]:
    # Legacy entries recorded as "ready" without any data or model: say what they are.
    if m.get("status") in ("ready", "bootstrap") and not m.get("metrics", {}).get("samples"):
      m["status"] = "invalid-no-training-data"
  registry["models"] = [m for m in registry["models"] if m.get("version") != version] + [{
    "version": version,
    "file": out.name,
    "trained_at": spec["training"]["trained_at"],
    "status": "candidate",
    "fingerprint": fingerprint,
    "gate": gate,
    "metrics": {"test": t, "validation": metrics["validation"]},
  }]
  REGISTRY.write_text(json.dumps(registry, indent=2) + "\n")
  print(json.dumps({"version": version, "gate": gate, "test": t}, indent=2))
  return out


def promote(file_name: str) -> None:
  path = MODELS_DIR / Path(file_name).name
  spec = json.loads(path.read_text())
  if not spec.get("gate", {}).get("passed"):
    raise SystemExit(f"refusing to promote {spec.get('version')}: it did not pass the promotion gate")
  KpForecaster(spec)  # must load with this code's feature set
  registry = load_registry()
  for m in registry["models"]:
    if m.get("status") == "promoted":
      m["status"] = "retired"
    if m.get("version") == spec["version"]:
      m["status"] = "promoted"
  REGISTRY.write_text(json.dumps(registry, indent=2) + "\n")
  PROMOTED_POINTER.write_text(json.dumps({
    "file": path.name,
    "version": spec["version"],
    "promoted_at": datetime.now(tz=timezone.utc).isoformat(),
    "gate": spec["gate"],
  }, indent=2) + "\n")
  print(f"promoted {spec['version']}")


if __name__ == "__main__":
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument("--promote", metavar="FILE", help="promote a gate-passing candidate in ml/models/")
  parser.add_argument("--skip-if-unchanged", action="store_true",
                      help="don't retrain when this exact data, code and library set is already registered")
  args = parser.parse_args()
  if args.promote:
    promote(args.promote)
  else:
    train(skip_if_unchanged=args.skip_if_unchanged)
