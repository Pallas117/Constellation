"""Tests for the nightly run's incremental telemetry count, skip-if-unchanged (GAU-156) and its
wall-time / peak-memory log fields.

Run: python3 -I ml/tests/test_nightly.py   (also run by npm test via backend/ml-client/client.test.ts)
"""

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "train"))
sys.path.insert(0, str(ML_DIR))

import nightly  # noqa: E402
import train_kp  # noqa: E402

CANON = '{"type":"canonical","speed":400}\n'
MMS = '{"type":"mms","x":1}\n'


class CountCanonicalTest(unittest.TestCase):
  def setUp(self):
    self.dir = Path(tempfile.mkdtemp())
    self.tel = self.dir / "telemetry.jsonl"
    self.state = self.dir / "state" / "count.json"

  def count(self):
    return nightly.count_canonical(self.tel, self.state)

  def test_missing_file_is_zero(self):
    self.assertEqual(self.count(), 0)

  def test_counts_then_reads_only_the_appended_bytes(self):
    self.tel.write_text(CANON * 3 + MMS)
    self.assertEqual(self.count(), 3)
    offset = json.loads(self.state.read_text())["offset"]
    self.assertEqual(offset, self.tel.stat().st_size)
    with self.tel.open("a") as f:
      f.write(CANON + MMS + CANON)
    self.assertEqual(self.count(), 5)

  def test_half_written_line_waits_for_its_newline(self):
    self.tel.write_text(CANON + '{"type":"canon')
    self.assertEqual(self.count(), 1)
    with self.tel.open("a") as f:
      f.write('ical","speed":1}\n')
    self.assertEqual(self.count(), 2)

  def test_line_spanning_chunks_is_counted_once(self):
    long_line = '{"type":"canonical","pad":"' + "x" * 50 + '"}\n'
    self.tel.write_text(long_line * 4)
    with mock.patch.object(nightly, "CHUNK", 7):
      self.assertEqual(self.count(), 4)
    self.assertEqual(json.loads(self.state.read_text())["offset"], self.tel.stat().st_size)

  def test_shrunk_or_replaced_file_is_recounted(self):
    self.tel.write_text(CANON * 5)
    self.assertEqual(self.count(), 5)
    self.tel.write_text(CANON)  # truncated in place: smaller than the stored offset
    self.assertEqual(self.count(), 1)
    replacement = self.dir / "new.jsonl"
    replacement.write_text(CANON * 2)
    replacement.replace(self.tel)  # rotated: new inode
    self.assertEqual(self.count(), 2)

  def test_never_modifies_the_telemetry(self):
    self.tel.write_text(CANON * 2 + MMS)
    before = self.tel.read_bytes()
    self.count()
    self.assertEqual(self.tel.read_bytes(), before)


class SkipIfUnchangedTest(unittest.TestCase):
  def setUp(self):
    self.models = Path(tempfile.mkdtemp())
    (self.models / "kp3h-mlp-v1-abc.json").write_text("{}")
    self.registry = {"models": [{"version": "kp3h-mlp-v1-abc", "file": "kp3h-mlp-v1-abc.json",
                                 "fingerprint": "fp1", "gate": {"passed": True}, "metrics": {"test": {"mae": 0.6}}}]}

  def found(self, version, fingerprint):
    with mock.patch.object(train_kp, "MODELS_DIR", self.models):
      return train_kp.already_trained(self.registry, version, fingerprint)

  def test_same_version_and_fingerprint_is_skipped(self):
    self.assertIsNotNone(self.found("kp3h-mlp-v1-abc", "fp1"))

  def test_changed_code_or_libraries_retrain(self):
    self.assertIsNone(self.found("kp3h-mlp-v1-abc", "fp2"))

  def test_missing_model_file_retrains(self):
    (self.models / "kp3h-mlp-v1-abc.json").unlink()
    self.assertIsNone(self.found("kp3h-mlp-v1-abc", "fp1"))

  def test_entries_without_a_fingerprint_retrain_once(self):
    del self.registry["models"][0]["fingerprint"]
    self.assertIsNone(self.found("kp3h-mlp-v1-abc", "fp1"))

  def test_unknown_code_identity_never_skips(self):
    self.assertEqual(train_kp.training_fingerprint({"2010": "aa"}, ""), "")
    self.assertIsNone(self.found("kp3h-mlp-v1-abc", ""))

  def test_fingerprint_changes_with_code_and_data(self):
    a = train_kp.training_fingerprint({"2010": "aa", "2011": "bb"}, "tree1")
    self.assertEqual(a, train_kp.training_fingerprint({"2011": "bb", "2010": "aa"}, "tree1"))  # order-free
    self.assertNotEqual(a, train_kp.training_fingerprint({"2010": "aa", "2011": "bb"}, "tree2"))
    self.assertNotEqual(a, train_kp.training_fingerprint({"2010": "aa", "2011": "cc"}, "tree1"))


TRAINED = {"version": "kp3h-mlp-v1-abc", "unchanged": True, "gate": {"passed": True},
           "test": {"mae": 0.6, "mae_persistence": 0.8}}


class RunLogUsageTest(unittest.TestCase):
  """Every log line carries wall time and peak memory; training itself is mocked."""

  def setUp(self):
    self.dir = Path(tempfile.mkdtemp())

  def run_main(self, paused=False, returncode=0):
    done = subprocess.CompletedProcess([], returncode, stdout=json.dumps(TRAINED), stderr="boom")
    out = io.StringIO()
    with mock.patch.object(nightly, "PAUSE_FLAG", self.dir / ("flag" if paused else "absent")), \
         mock.patch.object(nightly.subprocess, "run", return_value=done) as run, \
         mock.patch.object(sys, "argv", ["nightly.py", "--telemetry", str(self.dir / "none.jsonl")]), \
         mock.patch("sys.stdout", out):
      if paused:
        (self.dir / "flag").touch()
      code = nightly.main()
    self.assertEqual(run.called, not paused)
    return code, json.loads(out.getvalue())

  def assert_usage(self, log):
    keys = list(log)
    self.assertEqual(keys[:2], ["run", "live_points"])  # existing fields keep their order
    self.assertEqual(keys[-3:], ["seconds", "peak_rss_mb", "child_peak_rss_mb"])
    for key in ("seconds", "peak_rss_mb", "child_peak_rss_mb"):
      self.assertIsInstance(log[key], (int, float))
      self.assertNotIsInstance(log[key], bool)
      self.assertGreaterEqual(log[key], 0)
    self.assertIsInstance(log["peak_rss_mb"], int)
    self.assertIsInstance(log["child_peak_rss_mb"], int)
    self.assertGreater(log["peak_rss_mb"], 0)  # a running Python is never 0 MB

  def test_unchanged_run_logs_usage(self):
    code, log = self.run_main()
    self.assertEqual((code, log["status"]), (0, "unchanged"))
    self.assert_usage(log)

  def test_paused_run_logs_usage(self):
    code, log = self.run_main(paused=True)
    self.assertEqual((code, log["status"]), (0, "paused"))
    self.assert_usage(log)

  def test_failed_run_logs_usage(self):
    code, log = self.run_main(returncode=1)
    self.assertEqual((code, log["status"]), (1, "failed"))
    self.assert_usage(log)

  def test_maxrss_unit_matches_the_platform(self):
    self.assertEqual(nightly._MAXRSS_PER_MB, 1 << 20 if sys.platform == "darwin" else 1 << 10)


if __name__ == "__main__":
  unittest.main()
