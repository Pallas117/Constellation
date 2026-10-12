"""Unit tests for the Kp forecaster's shared code and promotion guard (GAU-113).

Run: python3 -I ml/tests/test_kp_model.py   (also run by npm test via backend/ml-client/client.test.ts)
"""

import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR))

from kp_model import FEATURE_NAMES, MODELS_DIR, WINDOW_HOURS, KpForecaster, feature_vector, hourly_row, newell_coupling  # noqa: E402


class KpModelTest(unittest.TestCase):
  def test_newell_is_zero_for_northward_field_and_grows_southward(self):
    self.assertAlmostEqual(newell_coupling(400, 0, 5), 0.0, places=9)
    self.assertGreater(newell_coupling(400, 0, -10), newell_coupling(400, 0, -2))
    self.assertTrue(math.isnan(newell_coupling(float("nan"), 0, -5)))

  def test_feature_vector_requires_a_full_finite_window(self):
    row = hourly_row(-3, 1, 450, 5, 2)
    self.assertIsNone(feature_vector([row] * (WINDOW_HOURS - 1), 2.0))
    self.assertIsNone(feature_vector([row] * (WINDOW_HOURS - 1) + [hourly_row(float("nan"), 1, 450, 5, 2)], 2.0))
    self.assertEqual(feature_vector([row] * WINDOW_HOURS, 2.0).shape, (len(FEATURE_NAMES),))

  def test_model_with_a_different_feature_set_is_rejected(self):
    with self.assertRaises(ValueError):
      KpForecaster({"version": "x", "feature_names": ["other"], "scaler": {"mean": [], "std": []}, "members": []})

  def test_promotion_refuses_a_candidate_that_failed_the_gate(self):
    promoted = MODELS_DIR / "promoted.json"
    before = promoted.read_text() if promoted.exists() else None
    bad = MODELS_DIR / "test-failed-gate-candidate.json"
    bad.write_text(json.dumps({"version": "test-failed", "gate": {"passed": False}}))
    try:
      result = subprocess.run(
        [sys.executable, "-I", str(ML_DIR / "train" / "train_kp.py"), "--promote", bad.name],
        capture_output=True, text=True,
      )
      self.assertNotEqual(result.returncode, 0)
      self.assertIn("did not pass the promotion gate", result.stderr + result.stdout)
      self.assertEqual(promoted.read_text() if promoted.exists() else None, before, "pointer untouched")
    finally:
      bad.unlink()


if __name__ == "__main__":
  unittest.main()
