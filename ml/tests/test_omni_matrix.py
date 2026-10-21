"""OMNI matrix cache and zero-copy training windows give exactly the old results.

Run: python3 -I ml/tests/test_omni_matrix.py   (also run by npm test via backend/ml-client/client.test.ts)
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "train"))
sys.path.insert(0, str(ML_DIR))

import omni  # noqa: E402
import train_kp  # noqa: E402
from kp_model import HORIZON_HOURS, WINDOW_HOURS  # noqa: E402


def omni_line(year: int, hour: int, rng: np.random.Generator) -> str:
  w = ["0"] * 40
  w[0], w[1], w[2] = str(year), str(1 + hour // 24), str(hour % 24)
  w[15] = "999.9" if hour % 37 == 0 else f"{rng.normal(0, 4):.1f}"   # By (with fills)
  w[16] = f"{rng.normal(-1, 5):.1f}"                                 # Bz
  w[23] = f"{abs(rng.normal(5, 2)):.1f}"                             # density
  w[24] = "9999." if hour % 53 == 0 else f"{abs(rng.normal(420, 80)):.0f}."  # speed (with fills)
  w[28] = f"{abs(rng.normal(2, 1)):.2f}"                             # pressure
  w[38] = str(int(rng.integers(0, 90)))                              # Kp * 10
  return " ".join(w)


def write_year(data_dir: Path, year: int, hours: int, seed: int) -> Path:
  rng = np.random.default_rng(seed)
  p = data_dir / f"omni2_{year}.dat"
  p.write_text("\n".join(omni_line(year, h, rng) for h in range(hours)) + "\n")
  return p


def old_load_years(years, data_dir):
  parts = [omni.parse_lines((data_dir / f"omni2_{y}.dat").read_text().splitlines()) for y in years]
  return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def old_build_split_from(d):
  hourly = np.stack([d["bz_gsm"], d["by_gsm"], d["speed"], d["density"], d["pressure"],
                     train_kp.newell_vec(d["speed"], d["by_gsm"], d["bz_gsm"])], axis=1)
  n = hourly.shape[0]
  t = np.arange(WINDOW_HOURS - 1, n - HORIZON_HOURS)
  windows = np.stack([hourly[t - lag] for lag in range(WINDOW_HOURS - 1, -1, -1)], axis=1)
  x = np.concatenate([windows.reshape(len(t), -1), d["kp"][t, None]], axis=1)
  y = d["kp"][t + HORIZON_HOURS]
  ok = np.all(np.isfinite(x), axis=1) & np.isfinite(y)
  return x[ok], y[ok], d["kp"][t][ok]


class OmniMatrixTest(unittest.TestCase):
  def setUp(self):
    self.dir = Path(tempfile.mkdtemp())
    write_year(self.dir, 2097, 500, seed=1)
    write_year(self.dir, 2098, 400, seed=2)

  def test_matrix_equals_parsed_text_exactly_including_fills(self):
    m = omni.year_matrix(2097, self.dir)
    d = omni.parse_lines((self.dir / "omni2_2097.dat").read_text().splitlines())
    self.assertEqual(m.shape, (500, len(omni.MATRIX_COLUMNS)))
    self.assertEqual(m.dtype, np.float64)
    for j, name in enumerate(omni.MATRIX_COLUMNS):
      np.testing.assert_array_equal(m[:, j], d[name], err_msg=name)
    self.assertTrue(np.isnan(m[0, omni.MATRIX_COLUMNS.index("by_gsm")]), "fill value becomes NaN")

  def test_second_load_is_a_memory_map_and_does_not_reparse(self):
    omni.year_matrix(2097, self.dir)
    with mock.patch.object(omni, "parse_lines", side_effect=AssertionError("re-parsed")):
      m = omni.year_matrix(2097, self.dir)
    self.assertIsInstance(m, np.memmap)
    self.assertFalse(m.flags.writeable, "read-only")
    self.assertEqual([p.name for p in (self.dir / "cache").iterdir() if p.name.endswith(".part")], [])

  def test_changed_source_gets_a_fresh_cache(self):
    first = np.array(omni.year_matrix(2097, self.dir))
    write_year(self.dir, 2097, 500, seed=99)
    second = np.array(omni.year_matrix(2097, self.dir))
    self.assertFalse(np.array_equal(first, second, equal_nan=True), "new download, new values")
    np.testing.assert_array_equal(second, omni.parse_matrix((self.dir / "omni2_2097.dat").read_text().splitlines()))

  def test_load_years_matches_the_old_implementation(self):
    new = omni.load_years([2097, 2098], self.dir)
    old = old_load_years([2097, 2098], self.dir)
    self.assertEqual(set(new), set(old))
    for k in old:
      np.testing.assert_array_equal(new[k], old[k], err_msg=k)

  def test_zero_copy_windows_give_identical_training_data(self):
    d = omni.load_years([2097, 2098], self.dir)
    with mock.patch.object(train_kp, "load_years", return_value=d):
      x, y, kp = train_kp.build_split([2097, 2098])
    ox, oy, okp = old_build_split_from(old_load_years([2097, 2098], self.dir))
    self.assertGreater(len(y), 500, "enough complete windows left after the injected fills")
    np.testing.assert_array_equal(x, ox)
    np.testing.assert_array_equal(y, oy)
    np.testing.assert_array_equal(kp, okp)


if __name__ == "__main__":
  unittest.main()
