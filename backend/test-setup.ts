// Loaded via `node --import` for `npm test`: keeps tests from appending to the
// tracked data/bedrock/telemetry.jsonl by pointing bedrock at a throwaway dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.GAUSS_BEDROCK_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-bedrock-test-"));
  process.env.GAUSS_BEDROCK_DIR = dir;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
