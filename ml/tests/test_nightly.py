"""Tests for the nightly run's incremental telemetry count and skip-if-unchanged (GAU-156).

Run: python3 -I ml/tests/test_nightly.py   (also run by npm test via backend/ml-client/client.test.ts)
"""

import json
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


if __name__ == "__main__":
  unittest.main()
