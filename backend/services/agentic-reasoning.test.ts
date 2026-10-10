import assert from "node:assert/strict";
import test from "node:test";
import { AgenticReasoningEngine } from "./agentic-reasoning.js";

test("offline fallback is an explicit unknown, never a canned assessment (GAU-44)", () => {
  const engine = new AgenticReasoningEngine() as unknown as {
    seekDeepLensTruth: (q: string) => { answer: string; traces: string[]; confidence: number };
  };
  for (const q of ["radiation risk at LEO?", "is the mission ok?"]) {
    const r = engine.seekDeepLensTruth(q);
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.traces, []);
    assert.doesNotMatch(r.answer, /CRITICAL|status nominal/i);
    assert.match(r.answer, /unknown/i);
  }
});
