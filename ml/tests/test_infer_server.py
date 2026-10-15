"""Request handling tests for the local inference server (GAU-124).

Run: python3 -I ml/tests/test_infer_server.py   (also run by npm test via backend/ml-client/client.test.ts)
"""

import http.client
import json
import sys
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "infer"))

import infer_server  # noqa: E402


class InferServerTest(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    infer_server.Handler.log_message = lambda *args: None
    cls.server = HTTPServer(("127.0.0.1", 0), infer_server.Handler)
    cls.port = cls.server.server_port
    threading.Thread(target=cls.server.serve_forever, daemon=True).start()

  @classmethod
  def tearDownClass(cls):
    cls.server.shutdown()
    cls.server.server_close()

  def post(self, path, body=b"", headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
    try:
      conn.putrequest("POST", path)
      for key, value in (headers or {"Content-Length": str(len(body))}).items():
        conn.putheader(key, value)
      conn.endheaders()
      if body:
        conn.send(body)
      res = conn.getresponse()
      return res.status, json.loads(res.read() or b"{}")
    finally:
      conn.close()

  def test_valid_request_is_served(self):
    status, body = self.post("/infer", json.dumps({"horizonMinutes": 30, "sequence": []}).encode())
    self.assertEqual(status, 200)
    self.assertIn("predictions", body)

  def test_oversized_body_is_refused_without_reading_it(self):
    too_big = infer_server.MAX_BODY_BYTES + 1
    status, body = self.post("/infer", headers={"Content-Length": str(too_big)})
    self.assertEqual(status, 413)
    self.assertEqual(body, {"error": "Request body too large"})

  def test_invalid_content_length_is_refused(self):
    for value in ("abc", "-5"):
      status, body = self.post("/infer-anomaly", headers={"Content-Length": value})
      self.assertEqual(status, 400, value)
      self.assertEqual(body, {"error": "Invalid Content-Length"})

  def test_errors_name_the_class_without_echoing_details(self):
    status, body = self.post("/infer", b'{"horizonMinutes": "not-a-number-secret-detail"}')
    self.assertEqual(status, 400)
    self.assertEqual(body, {"error": "ValueError"})

  def test_unknown_path_is_404(self):
    status, _ = self.post("/other", b"{}")
    self.assertEqual(status, 404)


if __name__ == "__main__":
  unittest.main()
