"""NASA OMNI2 hourly data: download (cached) and parse (GAU-113).

Format: https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2.text
Whitespace-separated words; fill values (999.9, 9999., 99.99, 99) become NaN.
"""

from __future__ import annotations

import hashlib
import ssl
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, Iterable

import numpy as np

BASE_URL = "https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2_{year}.dat"
DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "omni"

# 1-based word number -> (name, fill value)
COLUMNS = {
  1: ("year", None),
  2: ("doy", None),
  3: ("hour", None),
  16: ("by_gsm", 999.9),
  17: ("bz_gsm", 999.9),
  24: ("density", 999.9),
  25: ("speed", 9999.0),
  29: ("pressure", 99.99),
  39: ("kp10", 99.0),
}


def ensure_year(year: int, data_dir: Path = DATA_DIR) -> Path:
  data_dir.mkdir(parents=True, exist_ok=True)
  path = data_dir / f"omni2_{year}.dat"
  if not path.exists() or path.stat().st_size == 0:
    tmp = path.with_suffix(".part")
    download(BASE_URL.format(year=year), tmp)
    tmp.replace(path)
  return path


def _tls_context() -> ssl.SSLContext:
  """Verified TLS. python.org builds ship without CA certs, so prefer certifi's bundle when present."""
  try:
    import certifi
    return ssl.create_default_context(cafile=certifi.where())
  except ImportError:
    return ssl.create_default_context()


def download(url: str, dest: Path) -> None:
  """Fetch with certificate verification always on (GAU-127): urllib with a CA bundle, else curl,
  which verifies against the macOS system trust store. Never disables verification."""
  try:
    with urllib.request.urlopen(url, timeout=120, context=_tls_context()) as resp, open(dest, "wb") as out:
      out.write(resp.read())
  except (urllib.error.URLError, ssl.SSLError):
    subprocess.run(["curl", "-fsSL", "--max-time", "180", "-o", str(dest), url], check=True)


def sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_lines(lines: Iterable[str]) -> Dict[str, np.ndarray]:
  rows = []
  for line in lines:
    words = line.split()
    if len(words) < 39:
      continue
    rows.append([float(words[i - 1]) for i in COLUMNS])
  arr = np.asarray(rows, dtype=np.float64).reshape(-1, len(COLUMNS))
  out: Dict[str, np.ndarray] = {}
  for j, (name, fill) in enumerate(COLUMNS.values()):
    col = arr[:, j].copy()
    if fill is not None:
      col[np.isclose(col, fill)] = np.nan
    out[name] = col
  out["kp"] = out.pop("kp10") / 10.0
  return out


def load_years(years: Iterable[int], data_dir: Path = DATA_DIR) -> Dict[str, np.ndarray]:
  """Concatenate years into continuous hourly arrays (OMNI2 files are complete hourly grids)."""
  parts = [parse_lines(ensure_year(y, data_dir).read_text().splitlines()) for y in years]
  return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
