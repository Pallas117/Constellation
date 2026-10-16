#!/usr/bin/env python3
"""Lightweight local inference server for nowcasting API integration."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List

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
      self._json(200, {"ok": True, "modelVersion": MODEL_VERSION, "method": METHOD})
      return
    self._json(404, {"error": "Not found"})

  def do_POST(self) -> None:
    if self.path == "/infer-anomaly":
      # No anomaly model has been trained; answer explicitly instead of inventing a forecast.
      self._json(200, {
        "available": False,
        "modelVersion": None,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "horizonHours": 72,
        "reason": "No trained anomaly model is deployed.",
      })
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
