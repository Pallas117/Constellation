import assert from "node:assert/strict";
import test from "node:test";
import { AgenticReasoningEngine, type ReasoningResult } from "./agentic-reasoning.js";
import type { GraphDBClient } from "./graphdb-client.js";
import type { NotebookLMClient } from "./notebooklm-client.js";
import { linkGuardian, type ConnectivityMode } from "../lib/connectivity.js";

// Retrieval stubs returning what the old online path consumed: canned notebook text and a
// graph trace carrying the path/confidence fields it assumed GraphTrace had (GAU-96).
const engineWithCannedRetrieval = () =>
  new AgenticReasoningEngine(
    { queryNotebook: async () => ({ answer: "CANNED_NOTEBOOK_ANSWER", citations: [] }) } as unknown as NotebookLMClient,
    {
      traceAnomalyPath: async () => ({ nodes: [], edges: [], path: ["SUN", "CANNED_TERMINAL_NODE"], confidence: 0.9 }),
    } as unknown as GraphDBClient,
  );

const assertExplicitUnknown = (r: ReasoningResult) => {
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.traces, []);
  assert.doesNotMatch(r.answer, /CRITICAL|status nominal/i);
  assert.match(r.answer, /unknown/i);
};

test("offline fallback is an explicit unknown, never a canned assessment (GAU-44)", () => {
  const engine = engineWithCannedRetrieval() as unknown as {
    seekDeepLensTruth: (q: string) => ReasoningResult;
  };
  for (const q of ["radiation risk at LEO?", "is the mission ok?"]) {
    assertExplicitUnknown(engine.seekDeepLensTruth(q));
  }
});

test("answers are an explicit unknown in every link mode until retrieval is grounded (GAU-96)", async (t) => {
  const engine = engineWithCannedRetrieval();
  const status = t.mock.method(linkGuardian, "getStatus");
  for (const mode of ["CLOUD", "SAT", "AIRGAP"] satisfies ConnectivityMode[]) {
    status.mock.mockImplementation(() => ({ mode, latencyMs: 0, lastChecked: new Date(0).toISOString() }));
    const r = await engine.generateVerifiedTacticalResponse("debris conjunction risk at LEO?");
    assertExplicitUnknown(r);
    assert.doesNotMatch(r.answer, /VERIFICATION PASS|CANNED_|orbital drag|risk of impact|Sun -> Earth/i, mode);
  }
});
