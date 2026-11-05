"""NASA OMNI2 hourly data: download (cached) and parse (GAU-113).

Format: https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2.text
Whitespace-separated words; fill values (999.9, 9999., 99.99, 99) become NaN.

Each year is parsed once into a fixed-width float64 matrix (hours x MATRIX_COLUMNS) saved as .npy
next to the text files and memory-mapped afterwards, so training reads a matrix instead of
re-parsing ~2.9 MB of text per year. The cache name carries the source file's SHA-256, so a changed
download is never served stale. float64 keeps training bit-identical to parsing the text.
"""

from __future__ import annotations

import hashlib
import os
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


# Column order of the per-year matrix (parse_lines' names, with kp already divided by 10).
MATRIX_COLUMNS = ("year", "doy", "hour", "by_gsm", "bz_gsm", "density", "speed", "pressure", "kp")


def parse_matrix(lines: Iterable[str]) -> np.ndarray:
  """(hours, len(MATRIX_COLUMNS)) float64, the same values parse_lines returns."""
  d = parse_lines(lines)
  return np.column_stack([d[c] for c in MATRIX_COLUMNS]).astype(np.float64, copy=False)


def year_matrix(year: int, data_dir: Path = DATA_DIR) -> np.ndarray:
  """One year as a read-only memory-mapped matrix, parsing the text only the first time."""
  src = ensure_year(year, data_dir)
  key = sha256(src)[:16]
  cache = data_dir / "cache" / f"omni2_{year}-{key}.npy"
  if not cache.exists():
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_name(f".{cache.name}.{os.getpid()}.part")
    with tmp.open("wb") as f:  # np.save on a handle keeps the .part name (no added .npy)
      np.save(f, parse_matrix(src.read_text().splitlines()))
    os.replace(tmp, cache)  # atomic: a reader sees no cache or a complete one
  return np.load(cache, mmap_mode="r")


def load_years(years: Iterable[int], data_dir: Path = DATA_DIR) -> Dict[str, np.ndarray]:
  """Concatenate years into continuous hourly arrays (OMNI2 files are complete hourly grids).

  Returns column views into one (hours, columns) matrix built from the per-year caches.
  """
  m = np.concatenate([year_matrix(y, data_dir) for y in years], axis=0)
  return {name: m[:, j] for j, name in enumerate(MATRIX_COLUMNS)}
