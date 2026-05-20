#!/usr/bin/env python3
"""Lightweight local inference server for nowcasting API integration."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List

MODEL_VERSION = "unet-baseline-v1"


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
  predictions: List[Dict[str, float | str]] = []

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
        "confidence": max(0.35, min(0.95, 0.9 - i * 0.02)),
      }
    )

  return {
    "modelVersion": MODEL_VERSION,
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
      self._json(200, {"ok": True, "modelVersion": MODEL_VERSION})
      return
    self._json(404, {"error": "Not found"})

  def do_POST(self) -> None:
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
  server = HTTPServer(("0.0.0.0", 8000), Handler)
  print("Inference server listening on :8000")
  server.serve_forever()


if __name__ == "__main__":
  main()
