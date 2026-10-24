// Loaded via `node --import` for `npm test`: keeps tests from appending to the
// tracked data/bedrock/telemetry.jsonl by pointing bedrock at a throwaway dir,
// and from opening the real .auth.db (anything importing backend/better-auth.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.GAUSS_BEDROCK_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-bedrock-test-"));
  process.env.GAUSS_BEDROCK_DIR = dir;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

if (!process.env.AUTH_DB_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-auth-test-"));
  process.env.AUTH_DB_PATH = path.join(dir, "auth.db");
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
