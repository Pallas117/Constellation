#!/usr/bin/env python3
"""Lightweight local inference server for nowcasting API integration."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kp_model import HORIZON_HOURS, WINDOW_HOURS, KpForecaster, feature_vector, hourly_row  # noqa: E402

# No trained model is loaded: this server runs a fixed formula and says so.
MODEL_VERSION = "heuristic-nowcast-v0"
METHOD = "heuristic"


def infer(payload: Dict[str, Any]) -> Dict[str, Any]:
  horizon = int(payload.get("horizonMinutes", 60))
  sequence = payload.get("sequence", [])
  latest = sequence[-1] if sequence else {}

  sw = latest.get("solarWind", {})
  b = latest.get("magneticField", {})
  idx = latest.get("indices", {})
  coupling = latest.get("coupling", {})

  speed = float(sw.get("speed", 400.0))
  density = float(sw.get("density", 5.0))
  bz = float(b.get("z", 0.0))
  kp = float(idx.get("kp", 2.0))
  newell = float(coupling.get("newell", 0.0))

  steps = max(1, min(24, horizon // 5))
  now = datetime.now(tz=timezone.utc)
  predictions: List[Dict[str, Any]] = []

  for i in range(steps):
    minutes = (i + 1) * 5
    driver = max(0.0, -bz) * 0.45 + (speed - 350.0) * 0.004 + density * 0.05 + newell / 8000.0
    perturb = kp * 8.0 + driver * 12.0
    aurora = max(0.0, min(1.0, (kp / 9.0) * 0.7 + driver * 0.03))

    predictions.append(
      {
        "timestamp": (now + timedelta(minutes=minutes)).isoformat(),
        "geomagneticPerturbation": perturb,
        "auroraIntensity": aurora,
        # A fixed formula has no calibrated confidence.
        "confidence": None,
      }
    )

  return {
    "modelVersion": MODEL_VERSION,
    "method": METHOD,
    "generatedAt": now.isoformat(),
    "horizonMinutes": horizon,
    "predictions": predictions,
  }


_model: Optional[KpForecaster] = None
_model_error: Optional[str] = None
_model_loaded = False


def promoted_model() -> Tuple[Optional[KpForecaster], Optional[str]]:
  """The model that passed the promotion gate (loaded once), or a reason there is none."""
  global _model, _model_error, _model_loaded
  if not _model_loaded:
    _model_loaded = True
    try:
      _model = KpForecaster.load_promoted()
      if _model is None:
        _model_error = "No trained anomaly model is deployed."
    except Exception as exc:  # noqa: BLE001
      _model_error = f"Promoted model failed to load: {type(exc).__name__}"
  return _model, _model_error


def _num(value: Any) -> Optional[float]:
  return float(value) if isinstance(value, (int, float)) and value == value else None


def hourly_window(sequence: List[Dict[str, Any]]) -> Tuple[Optional[List[List[float]]], Optional[float], int]:
  """Hourly means of the live drivers over the last WINDOW_HOURS hours, oldest first.

  Returns (rows, kp_now, hours_covered); rows is None unless every hour has data.
  Points flagged stale are ignored: they are not measurements of that hour.
  """
  points = []
  for p in sequence:
    if not isinstance(p, dict) or (p.get("quality") or {}).get("stale") is True:
      continue
    try:
      t = datetime.fromisoformat(str(p["timestamp"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
      continue
    sw, b, idx = p.get("solarWind") or {}, p.get("magneticField") or {}, p.get("indices") or {}
    vals = [_num(b.get("z")), _num(b.get("y")), _num(sw.get("speed")), _num(sw.get("density")),
            _num(sw.get("dynamicPressure")), _num(idx.get("kp"))]
    if all(v is not None for v in vals):
      points.append((t, vals))
  if not points:
    return None, None, 0
  points.sort(key=lambda tp: tp[0])
  latest = points[-1][0]
  buckets: List[List[List[float]]] = [[] for _ in range(WINDOW_HOURS)]
  for t, vals in points:
    lag = int((latest - t) // 3600)
    if 0 <= lag < WINDOW_HOURS:
      buckets[WINDOW_HOURS - 1 - lag].append(vals)
  covered = sum(1 for b in buckets if b)
  if covered < WINDOW_HOURS:
    return None, None, covered
  rows = []
  for b in buckets:
    mean = [sum(v[i] for v in b) / len(b) for i in range(5)]
    rows.append(hourly_row(*mean))
  return rows, points[-1][1][5], covered


def _unavailable(reason: str) -> Dict[str, Any]:
  return {
    "available": False,
    "modelVersion": None,
    "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
    "horizonHours": HORIZON_HOURS,
    "reason": reason,
  }


def anomaly(payload: Dict[str, Any]) -> Dict[str, Any]:
  model, error = promoted_model()
  if model is None:
    return _unavailable(error or "No trained anomaly model is deployed.")
  sequence = payload.get("sequence") if isinstance(payload.get("sequence"), list) else []
  rows, kp_now, covered = hourly_window(sequence)
  features = feature_vector(rows, kp_now) if rows is not None and kp_now is not None else None
  if features is None:
    return _unavailable(f"Needs {WINDOW_HOURS} h of live solar-wind history; have {covered} h.")
  out = model.predict(features)
  p = float(out["storm_probability"][0])
  lo, hi = (float(out["storm_probability_range"][0][0]), float(out["storm_probability_range"][1][0]))
  kp = float(out["kp"][0])
  if p >= 0.5:
    message = f"G1+ storm likely within {HORIZON_HOURS} h (P = {p:.0%})."
  elif p >= 0.2:
    message = f"Elevated chance of a G1+ storm within {HORIZON_HOURS} h (P = {p:.0%})."
  else:
    message = f"No storm expected within {HORIZON_HOURS} h (P = {p:.0%})."
  return {
    "available": True,
    "method": "model",
    "modelVersion": model.version,
    "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
    "horizonHours": HORIZON_HOURS,
    "anomalyProbability": p,
    # Kp estimate trails persistence during storms (see the model's gate warnings).
    "predictedKpMax": kp,
    "warningMessage": message,
    # Spread of the ensemble members, not a calibrated interval.
    "confidenceInterval": [lo, hi],
  }


class Handler(BaseHTTPRequestHandler):
  def _json(self, status: int, payload: Dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self) -> None:
    if self.path == "/health":
      model, _ = promoted_model()
      self._json(200, {
        "ok": True,
        "modelVersion": MODEL_VERSION,
        "method": METHOD,
        "anomalyModel": model.version if model else None,
      })
      return
    self._json(404, {"error": "Not found"})

  def do_POST(self) -> None:
    if self.path == "/infer-anomaly":
      try:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        self._json(200, anomaly(payload if isinstance(payload, dict) else {}))
      except Exception as exc:  # noqa: BLE001
        self._json(400, {"error": type(exc).__name__})
      return
    if self.path != "/infer":
      self._json(404, {"error": "Not found"})
      return

    try:
      length = int(self.headers.get("Content-Length", "0"))
      raw = self.rfile.read(length)
      payload = json.loads(raw.decode("utf-8"))
      result = infer(payload)
      self._json(200, result)
    except Exception as exc:  # noqa: BLE001
      self._json(400, {"error": str(exc)})


def main() -> None:
  # Loopback by default: the backend is the only client. Set INFER_HOST to expose it deliberately.
  host = os.environ.get("INFER_HOST", "127.0.0.1")
  port = int(os.environ.get("INFER_PORT", "8000"))
  server = HTTPServer((host, port), Handler)
  print(f"Inference server listening on {host}:{server.server_port}", flush=True)
  server.serve_forever()


if __name__ == "__main__":
  main()
